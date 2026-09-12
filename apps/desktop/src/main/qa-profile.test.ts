import { describe, expect, it, vi } from "vitest";
import { applyQaUserDataOverride } from "./qa-profile.js";

describe("disposable QA profile override", () => {
  it("does nothing when the override is absent or blank", () => {
    const setPath = vi.fn();

    expect(applyQaUserDataOverride({ setPath }, {})).toBeNull();
    expect(applyQaUserDataOverride({ setPath }, { PROMPTBRANCH_QA_USER_DATA: "  " })).toBeNull();
    expect(setPath).not.toHaveBeenCalled();
  });

  it("sets an absolute isolated userData path", () => {
    const setPath = vi.fn();

    expect(
      applyQaUserDataOverride(
        { setPath },
        { PROMPTBRANCH_QA_USER_DATA: "/private/tmp/promptbranch-qa/user-data" },
      ),
    ).toBe("/private/tmp/promptbranch-qa/user-data");
    expect(setPath).toHaveBeenCalledWith("userData", "/private/tmp/promptbranch-qa/user-data");
  });

  it("rejects relative paths before Electron reads userData", () => {
    const setPath = vi.fn();

    expect(() =>
      applyQaUserDataOverride({ setPath }, { PROMPTBRANCH_QA_USER_DATA: "qa/user-data" }),
    ).toThrow("PROMPTBRANCH_QA_USER_DATA must be an absolute path");
    expect(setPath).not.toHaveBeenCalled();
  });
});
