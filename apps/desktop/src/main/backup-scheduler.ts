const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DUE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FAILURE_RETRY_MS = 15 * 60 * 1000;

export interface DailyBackupSchedulerDeps {
  latestBackupMtimeMs(): number | null;
  createBackup(): void;
  onError(error: unknown): void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface DailyBackupScheduler {
  start(): void;
  backupCompleted(): void;
  stop(): void;
}

/**
 * Keeps daily backups alive for long-running app sessions. The hourly ceiling
 * also makes wall-clock changes observable instead of trusting one day-long
 * timer scheduled against an old clock reading.
 */
export function createDailyBackupScheduler(
  deps: DailyBackupSchedulerDeps,
): DailyBackupScheduler {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  function clearPendingTimer(): void {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function schedule(delayMs: number): void {
    if (!running) return;
    clearPendingTimer();
    timer = setTimer(checkDue, Math.min(Math.max(delayMs, 0), DUE_CHECK_INTERVAL_MS));
    timer.unref?.();
  }

  function scheduleFromLatestBackup(): void {
    const latestMtimeMs = deps.latestBackupMtimeMs();
    if (latestMtimeMs === null) {
      schedule(FAILURE_RETRY_MS);
      return;
    }
    schedule(latestMtimeMs + BACKUP_MAX_AGE_MS - now());
  }

  function retryAfter(error: unknown): void {
    deps.onError(error);
    schedule(FAILURE_RETRY_MS);
  }

  function checkDue(): void {
    timer = null;
    if (!running) return;
    try {
      const latestMtimeMs = deps.latestBackupMtimeMs();
      if (latestMtimeMs !== null && now() - latestMtimeMs < BACKUP_MAX_AGE_MS) {
        scheduleFromLatestBackup();
        return;
      }

      deps.createBackup();
      scheduleFromLatestBackup();
    } catch (error) {
      retryAfter(error);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      checkDue();
    },
    backupCompleted() {
      if (!running) return;
      try {
        scheduleFromLatestBackup();
      } catch (error) {
        retryAfter(error);
      }
    },
    stop() {
      running = false;
      clearPendingTimer();
    },
  };
}
