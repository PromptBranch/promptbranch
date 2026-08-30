/**
 * Global vitest setup (runs for every test file, node and jsdom alike).
 *
 * Node ≥22 ships an experimental `localStorage` global whose getter returns
 * `undefined` unless `--localstorage-file` is passed. Vitest's jsdom
 * environment refuses to override existing globals, so inside jsdom tests the
 * broken Node getter shadows jsdom's Storage and `localStorage` is undefined.
 * Reinstall a real Storage (from a scratch JSDOM) when running under jsdom.
 * Do not probe Node's getter: reading it is what emits the warning.
 */
import { JSDOM } from "jsdom";

if (typeof window !== "undefined") {
  const dom = new JSDOM("", { url: "https://localhost/" });
  Object.defineProperty(globalThis, "localStorage", {
    value: dom.window.localStorage,
    configurable: true,
    writable: true,
  });
}
