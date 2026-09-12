import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleAutomaticUpdateCheck } from "./update-startup";

describe("automatic update startup scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks three seconds after startup", async () => {
    let checks = 0;
    scheduleAutomaticUpdateCheck(() => {
      checks += 1;
    });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(checks).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(checks).toBe(1);
  });
});
