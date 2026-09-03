import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDailyBackupScheduler } from "./backup-scheduler.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;

describe("daily backup scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps creating daily backups while the app remains open", async () => {
    let latestMtimeMs: number | null = Date.now();
    const createdAt: number[] = [];
    const scheduler = createDailyBackupScheduler({
      latestBackupMtimeMs: () => latestMtimeMs,
      createBackup: () => {
        latestMtimeMs = Date.now();
        createdAt.push(Date.now());
      },
      onError: vi.fn(),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(createdAt).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(createdAt).toEqual([Date.parse("2026-09-03T08:00:00.000Z")]);

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(createdAt).toEqual([
      Date.parse("2026-09-03T08:00:00.000Z"),
      Date.parse("2026-09-04T08:00:00.000Z"),
    ]);
  });

  it("moves the next automatic backup one day past a successful manual backup", async () => {
    let latestMtimeMs: number | null = Date.now();
    const automaticBackups: number[] = [];
    const scheduler = createDailyBackupScheduler({
      latestBackupMtimeMs: () => latestMtimeMs,
      createBackup: () => {
        latestMtimeMs = Date.now();
        automaticBackups.push(Date.now());
      },
      onError: vi.fn(),
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    latestMtimeMs = Date.now();
    scheduler.backupCompleted();

    await vi.advanceTimersByTimeAsync(18 * 60 * 60 * 1000);
    expect(automaticBackups).toEqual([]);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(automaticBackups).toEqual([Date.parse("2026-09-03T14:00:00.000Z")]);
  });

  it("retries a failed due backup after a bounded delay", async () => {
    let latestMtimeMs: number | null = null;
    let attempts = 0;
    const failure = new Error("disk full");
    const onError = vi.fn();
    const scheduler = createDailyBackupScheduler({
      latestBackupMtimeMs: () => latestMtimeMs,
      createBackup: () => {
        attempts += 1;
        if (attempts === 1) throw failure;
        latestMtimeMs = Date.now();
      },
      onError,
    });

    scheduler.start();
    expect(attempts).toBe(1);
    expect(onError).toHaveBeenCalledWith(failure);

    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
  });

  it("retries when inspecting the backup directory fails", async () => {
    let reads = 0;
    const failure = new Error("backup directory unavailable");
    const createBackup = vi.fn();
    const onError = vi.fn();
    const scheduler = createDailyBackupScheduler({
      latestBackupMtimeMs: () => {
        reads += 1;
        if (reads === 1) throw failure;
        return null;
      },
      createBackup,
      onError,
    });

    expect(() => scheduler.start()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(createBackup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(createBackup).toHaveBeenCalledOnce();
  });

  it("unrefs its timer and cancels pending work when stopped", async () => {
    let latestMtimeMs: number | null = Date.now();
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const createBackup = vi.fn(() => {
      latestMtimeMs = Date.now();
    });
    const scheduler = createDailyBackupScheduler({
      latestBackupMtimeMs: () => latestMtimeMs,
      createBackup,
      onError: vi.fn(),
      setTimer: (callback, delay) => {
        scheduled = setTimeout(callback, delay);
        return scheduled;
      },
    });

    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    expect(scheduled?.hasRef()).toBe(false);

    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DAY_MS * 2);
    expect(createBackup).not.toHaveBeenCalled();
  });
});
