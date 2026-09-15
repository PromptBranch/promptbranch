import { describe, expect, it, vi } from "vitest";
import { logRendererConsoleMessage } from "./logger.js";

describe("logRendererConsoleMessage", () => {
  it("ignores a broken stdout pipe so renderer logging cannot crash Electron", () => {
    const log = vi.fn(() => {
      const error = Object.assign(new Error("write EIO"), { code: "EIO" });
      throw error;
    });

    expect(() => logRendererConsoleMessage({ log }, 3, "renderer message")).not.toThrow();
    expect(log).toHaveBeenCalledWith("[renderer:error] renderer message");
  });

  it("rethrows unexpected logger failures", () => {
    const error = new Error("logger unavailable");
    const log = vi.fn(() => {
      throw error;
    });

    expect(() => logRendererConsoleMessage({ log }, 1, "renderer message")).toThrow(error);
  });
});
