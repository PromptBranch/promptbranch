import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBonjourDiscovery, type DiscoveredPeer } from "./discovery.js";

class FakeBrowser extends EventEmitter {
  stop = vi.fn();
}

describe("Bonjour discovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("bonjour-service");
  });

  it("refreshes a stable service through a fresh browser after its IPv4 address changes", async () => {
    vi.useFakeTimers();
    const browsers: FakeBrowser[] = [];
    class FakeBonjour {
      publish(): void {}
      find(): FakeBrowser {
        const browser = new FakeBrowser();
        browsers.push(browser);
        return browser;
      }
      async unpublishAll(): Promise<void> {}
      destroy(): void {}
    }
    vi.doMock("bonjour-service", () => ({ Bonjour: FakeBonjour }));
    const discovery = createBonjourDiscovery();
    const peers: DiscoveredPeer[] = [];
    const remoteFingerprint = "b".repeat(64);

    try {
      discovery.start(
        { port: 52_100, fingerprint: "a".repeat(64), deviceName: "Local" },
        (peer) => peers.push(peer),
        () => {},
      );
      await vi.dynamicImportSettled();
      expect(browsers).toHaveLength(1);

      browsers[0]?.emit("up", {
        name: "Remote",
        host: "remote.local",
        port: 52_101,
        addresses: ["192.0.2.10"],
        txt: { fp: remoteFingerprint },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(browsers).toHaveLength(2);
      expect(browsers[0]?.stop).toHaveBeenCalledOnce();

      browsers[1]?.emit("up", {
        name: "Remote",
        host: "remote.local",
        port: 52_101,
        addresses: ["192.0.2.11"],
        txt: { fp: remoteFingerprint },
      });

      expect(peers.map((peer) => peer.address)).toEqual(["192.0.2.10", "192.0.2.11"]);
    } finally {
      await discovery.stop();
    }
  });

  it("lets only the latest start own a Bonjour instance when import is pending", async () => {
    let resolveImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      resolveImportStarted = resolve;
    });
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const publishedNames: string[] = [];
    const instances: FakeBonjour[] = [];
    class FakeBonjour {
      constructor() {
        instances.push(this);
      }
      publish(config: { name: string }): void {
        publishedNames.push(config.name);
      }
      find(): FakeBrowser {
        return new FakeBrowser();
      }
      async unpublishAll(): Promise<void> {}
      destroy(): void {}
    }
    vi.doMock("bonjour-service", async () => {
      resolveImportStarted();
      await importGate;
      return { Bonjour: FakeBonjour };
    });
    const discovery = createBonjourDiscovery();

    try {
      discovery.start(
        { port: 52_100, fingerprint: "a".repeat(64), deviceName: "Old" },
        () => {},
        () => {},
      );
      await importStarted;
      await discovery.stop();
      discovery.start(
        { port: 52_101, fingerprint: "a".repeat(64), deviceName: "Current" },
        () => {},
        () => {},
      );
      releaseImport();
      await vi.dynamicImportSettled();

      expect(instances).toHaveLength(1);
      expect(publishedNames).toEqual(["PromptBranch Current"]);
    } finally {
      releaseImport();
      await discovery.stop();
    }
  });
});
