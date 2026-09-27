import { describe, expect, it } from "vitest";
import {
  createImportDispatcher,
  deepLinkFromArgv,
  parseImportDeepLink,
  type ImportIntent,
} from "./deep-link.js";

const ID = "V1StGXR8_Z5jdHi6B-myT";
const SNAPSHOT: ImportIntent = { kind: "snapshot", target: ID };
const MARKDOWN_URL = "https://example.com/prompts/review.md";
const MARKDOWN: ImportIntent = { kind: "markdown", url: MARKDOWN_URL };

describe("parseImportDeepLink", () => {
  it("extracts a percent-encoded snapshot URL", () => {
    const inner = `https://promptbranch.app/p/${ID}`;
    expect(
      parseImportDeepLink(`promptbranch://import?url=${encodeURIComponent(inner)}`),
    ).toEqual({ kind: "snapshot", target: inner });
  });

  it("accepts a raw snapshot id as the target", () => {
    expect(parseImportDeepLink(`promptbranch://import?url=${ID}`)).toEqual(SNAPSHOT);
  });

  it("parses a public Markdown URL import action", () => {
    expect(
      parseImportDeepLink(
        `promptbranch://import-markdown?url=${encodeURIComponent(MARKDOWN_URL)}`,
      ),
    ).toEqual(MARKDOWN);
  });

  it("rejects a Markdown URL that is not HTTPS", () => {
    expect(
      parseImportDeepLink(
        `promptbranch://import-markdown?url=${encodeURIComponent("http://example.com/a.md")}`,
      ),
    ).toBeNull();
  });

  it("rejects missing or duplicate URL parameters", () => {
    expect(parseImportDeepLink("promptbranch://import-markdown")).toBeNull();
    expect(
      parseImportDeepLink(
        `promptbranch://import-markdown?url=${encodeURIComponent(MARKDOWN_URL)}&url=${encodeURIComponent(MARKDOWN_URL)}`,
      ),
    ).toBeNull();
    expect(parseImportDeepLink(`promptbranch://import?url=${ID}&url=${ID}`)).toBeNull();
  });

  it("rejects an oversized deep link", () => {
    expect(
      parseImportDeepLink(
        `promptbranch://import-markdown?url=${encodeURIComponent(`https://example.com/${"a".repeat(2000)}.md`)}`,
      ),
    ).toBeNull();
  });

  it("rejects other schemes, actions and missing params", () => {
    expect(parseImportDeepLink(`https://import?url=${ID}`)).toBeNull();
    expect(parseImportDeepLink(`promptbranch://publish?url=${ID}`)).toBeNull();
    expect(parseImportDeepLink("promptbranch://import")).toBeNull();
    expect(parseImportDeepLink("not a url")).toBeNull();
  });

  it("rejects non-http(s) and malformed inner targets", () => {
    expect(parseImportDeepLink("promptbranch://import?url=javascript:alert(1)")).toBeNull();
    expect(parseImportDeepLink("promptbranch://import?url=file:///etc/passwd")).toBeNull();
    expect(parseImportDeepLink("promptbranch://import?url=hello%20world")).toBeNull();
  });
});

describe("deepLinkFromArgv", () => {
  it("finds a deep link among process args (Windows/Linux)", () => {
    const argv = ["/usr/bin/electron", ".", `promptbranch://import?url=${ID}`];
    expect(deepLinkFromArgv(argv)).toEqual(SNAPSHOT);
    expect(
      deepLinkFromArgv([
        "/usr/bin/electron",
        ".",
        `promptbranch://import-markdown?url=${encodeURIComponent(MARKDOWN_URL)}`,
      ]),
    ).toEqual(MARKDOWN);
  });

  it("returns null when no arg is a valid import link", () => {
    expect(deepLinkFromArgv(["/usr/bin/electron", "."])).toBeNull();
    expect(deepLinkFromArgv(["promptbranch://publish?url=x"])).toBeNull();
  });
});

describe("createImportDispatcher", () => {
  function setup(opts: { hasWindow?: boolean; ready?: boolean } = {}) {
    const state = { hasWindow: opts.hasWindow ?? false };
    const calls = { sent: [] as ImportIntent[], created: 0, focused: 0 };
    const dispatcher = createImportDispatcher<string>({
      getWindow: () => (state.hasWindow ? "win" : null),
      createWindow: () => {
        calls.created++;
        state.hasWindow = true;
      },
      send: (_window, intent) => {
        calls.sent.push(intent);
      },
      focus: () => {
        calls.focused++;
      },
    });
    if (opts.ready) dispatcher.rendererReady();
    return { dispatcher, state, calls };
  }

  it("sends immediately when the window exists and the renderer is ready", () => {
    const { dispatcher, calls } = setup({ hasWindow: true, ready: true });
    dispatcher.dispatch(SNAPSHOT);
    expect(calls.sent).toEqual([SNAPSHOT]);
    expect(calls.created).toBe(0);
    expect(calls.focused).toBe(1);
    expect(dispatcher.pending()).toBeNull();
  });

  it("queues and creates a window when none exists (macOS dock-only)", () => {
    const { dispatcher, calls } = setup();
    dispatcher.dispatch(SNAPSHOT);
    expect(calls.sent).toEqual([]);
    expect(calls.created).toBe(1);
    expect(dispatcher.pending()).toEqual(SNAPSHOT);
  });

  it("queues without creating a window when one exists but is not ready", () => {
    const { dispatcher, calls } = setup({ hasWindow: true });
    dispatcher.dispatch(MARKDOWN);
    expect(calls.sent).toEqual([]);
    expect(calls.created).toBe(0);
    expect(dispatcher.pending()).toEqual(MARKDOWN);
  });

  it("flushes the queued URL when the renderer signals ready", () => {
    const { dispatcher, calls } = setup();
    dispatcher.dispatch(SNAPSHOT);
    dispatcher.rendererReady();
    expect(calls.sent).toEqual([SNAPSHOT]);
    expect(dispatcher.pending()).toBeNull();
  });

  it("sends nothing on ready when nothing is queued", () => {
    const { dispatcher, calls } = setup({ hasWindow: true });
    dispatcher.rendererReady();
    expect(calls.sent).toEqual([]);
  });

  it("keeps only the latest queued URL (latest wins)", () => {
    const { dispatcher, calls } = setup();
    dispatcher.dispatch(SNAPSHOT);
    dispatcher.dispatch(MARKDOWN);
    dispatcher.rendererReady();
    expect(calls.sent).toEqual([MARKDOWN]);
  });

  it("never sends to an unready webContents after the window closes", () => {
    const { dispatcher, state, calls } = setup({ hasWindow: true, ready: true });
    state.hasWindow = false;
    dispatcher.windowClosed();
    dispatcher.dispatch(SNAPSHOT);
    expect(calls.sent).toEqual([]);
    expect(dispatcher.pending()).toEqual(SNAPSHOT);
    // Windowless again: the dispatcher recreates a window for the queued link.
    expect(calls.created).toBe(1);
  });

  it("resets readiness on window close even if the window object lingers", () => {
    const { dispatcher, calls } = setup({ hasWindow: true, ready: true });
    dispatcher.windowClosed();
    dispatcher.dispatch(MARKDOWN);
    expect(calls.sent).toEqual([]);
    expect(calls.created).toBe(0);
    expect(dispatcher.pending()).toEqual(MARKDOWN);
  });
});
