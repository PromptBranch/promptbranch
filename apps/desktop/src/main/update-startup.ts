const AUTOMATIC_UPDATE_STARTUP_DELAY_MS = 3_000;

export function scheduleAutomaticUpdateCheck(
  check: () => void,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(check, AUTOMATIC_UPDATE_STARTUP_DELAY_MS);
  timer.unref?.();
  return timer;
}
