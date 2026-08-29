import path from "node:path";
import { describe, expect, it } from "vitest";
import { DB_FILENAME, resolveDatabasePath } from "../src/paths.js";

const HOME = "/home/tester";

describe("resolveDatabasePath", () => {
  it("resolves to ~/Library/Application Support/PromptBranch on macOS", () => {
    expect(resolveDatabasePath({}, "darwin", HOME)).toBe(
      path.join(HOME, "Library", "Application Support", "PromptBranch", DB_FILENAME),
    );
  });

  it("uses %APPDATA% on Windows when set", () => {
    expect(resolveDatabasePath({ APPDATA: "C:\\Users\\tester\\AppData\\Roaming" }, "win32", HOME)).toBe(
      path.join("C:\\Users\\tester\\AppData\\Roaming", "PromptBranch", DB_FILENAME),
    );
  });

  it("falls back to ~/AppData/Roaming on Windows when APPDATA is unset", () => {
    expect(resolveDatabasePath({}, "win32", HOME)).toBe(
      path.join(HOME, "AppData", "Roaming", "PromptBranch", DB_FILENAME),
    );
  });

  it("uses $XDG_CONFIG_HOME on Linux when set", () => {
    expect(resolveDatabasePath({ XDG_CONFIG_HOME: "/xdg" }, "linux", HOME)).toBe(
      path.join("/xdg", "promptbranch", DB_FILENAME),
    );
  });

  it("falls back to ~/.config on Linux when XDG_CONFIG_HOME is unset", () => {
    expect(resolveDatabasePath({}, "linux", HOME)).toBe(
      path.join(HOME, ".config", "promptbranch", DB_FILENAME),
    );
  });

  it("PROMPTBRANCH_DB overrides the platform default on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(resolveDatabasePath({ PROMPTBRANCH_DB: "/tmp/scratch.db" }, platform, HOME)).toBe(
        path.resolve("/tmp/scratch.db"),
      );
    }
  });

  it("resolves a relative PROMPTBRANCH_DB against the cwd", () => {
    expect(resolveDatabasePath({ PROMPTBRANCH_DB: "scratch.db" }, "darwin", HOME)).toBe(
      path.resolve("scratch.db"),
    );
  });

  it("ignores a blank PROMPTBRANCH_DB", () => {
    expect(resolveDatabasePath({ PROMPTBRANCH_DB: "   " }, "linux", HOME)).toBe(
      path.join(HOME, ".config", "promptbranch", DB_FILENAME),
    );
  });

  it("falls through a blank PROMPTBRANCH_DB to a valid PROMPTHUB_DB", () => {
    expect(
      resolveDatabasePath({ PROMPTBRANCH_DB: "   ", PROMPTHUB_DB: "/tmp/deprecated.db" }, "darwin", HOME),
    ).toBe(path.resolve("/tmp/deprecated.db"));
  });

  it("honors the deprecated PROMPTHUB_DB as a fallback", () => {
    expect(resolveDatabasePath({ PROMPTHUB_DB: "/tmp/deprecated.db" }, "darwin", HOME)).toBe(
      path.resolve("/tmp/deprecated.db"),
    );
  });

  it("honors the deprecated PROMPTBUILDER_DB as a fallback", () => {
    expect(resolveDatabasePath({ PROMPTBUILDER_DB: "/tmp/legacy.db" }, "darwin", HOME)).toBe(
      path.resolve("/tmp/legacy.db"),
    );
  });

  it("PROMPTBRANCH_DB wins over PROMPTHUB_DB, which wins over PROMPTBUILDER_DB", () => {
    expect(
      resolveDatabasePath(
        { PROMPTBRANCH_DB: "/tmp/new.db", PROMPTHUB_DB: "/tmp/deprecated.db", PROMPTBUILDER_DB: "/tmp/legacy.db" },
        "darwin",
        HOME,
      ),
    ).toBe(path.resolve("/tmp/new.db"));
    expect(
      resolveDatabasePath({ PROMPTHUB_DB: "/tmp/deprecated.db", PROMPTBUILDER_DB: "/tmp/legacy.db" }, "darwin", HOME),
    ).toBe(path.resolve("/tmp/deprecated.db"));
  });
});
