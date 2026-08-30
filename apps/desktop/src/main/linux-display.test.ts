import { describe, expect, it, vi } from "vitest";

import { configureLinuxDisplayBackend } from "./linux-display.js";

describe("configureLinuxDisplayBackend", () => {
  it("defaults Linux to X11 when no Ozone backend was requested", () => {
    const commandLine = {
      hasSwitch: vi.fn(() => false),
      appendSwitch: vi.fn(),
    };

    configureLinuxDisplayBackend("linux", commandLine);

    expect(commandLine.appendSwitch).toHaveBeenCalledWith("ozone-platform", "x11");
  });

  it("preserves an explicitly requested Linux Ozone backend", () => {
    const commandLine = {
      hasSwitch: vi.fn(() => true),
      appendSwitch: vi.fn(),
    };

    configureLinuxDisplayBackend("linux", commandLine);

    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("does not change the display backend on other platforms", () => {
    const commandLine = {
      hasSwitch: vi.fn(() => false),
      appendSwitch: vi.fn(),
    };

    configureLinuxDisplayBackend("darwin", commandLine);

    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});
