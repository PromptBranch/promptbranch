import { describe, expect, it } from "vitest";
import { userErrorMessage } from "./errors";

describe("userErrorMessage", () => {
  it("removes Electron's remote-method wrapper from an actionable error", () => {
    expect(
      userErrorMessage(
        new Error(
          "Error invoking remote method 'share:publish': Error: Could not reach the portal: fetch failed",
        ),
      ),
    ).toBe("Could not reach the portal: fetch failed");
  });

  it("preserves ordinary error messages and string failures", () => {
    expect(userErrorMessage(new Error("Invalid provider URL"))).toBe("Invalid provider URL");
    expect(userErrorMessage("Timed out")).toBe("Timed out");
  });
});
