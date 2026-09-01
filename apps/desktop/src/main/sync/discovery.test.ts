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

  it("contains a Bonjour import failure", async () => {
    vi.useFakeTimers();
    vi.doMock("bonjour-service", () => {
      throw new Error("module unavailable");
    });
    const discovery = createBonjourDiscovery();

    discovery.start(
      { port: 52_100, fingerprint: "a".repeat(64), deviceName: "Local" },
      () => {},
      () => {},
    );
    await vi.dynamicImportSettled();

    expect(vi.getTimerCount()).toBe(0);
    await expect(discovery.stop()).resolves.toBeUndefined();
  });

  it("contains a Bonjour constructor failure", async () => {
    vi.useFakeTimers();
    class FakeBonjour {
      constructor() {
        throw new Error("constructor failed");
      }
    }
    vi.doMock("bonjour-service", () => ({ Bonjour: FakeBonjour }));
    const discovery = createBonjourDiscovery();

    discovery.start(
      { port: 52_100, fingerprint: "a".repeat(64), deviceName: "Local" },
      () => {},
      () => {},
    );
    await vi.dynamicImportSettled();

    expect(vi.getTimerCount()).toBe(0);
    await expect(discovery.stop()).resolves.toBeUndefined();
  });

  it("contains an asynchronous mDNS error without disabling discovery", async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    let mdnsErrorCallback!: (error: Error) => void;
    class FakeBonjour {
      constructor(_options?: unknown, errorCallback?: (error: Error) => void) {
        mdnsErrorCallback = errorCallback ?? ((error) => {
          throw error;
        });
      }
      publish(): void {}
      find(): FakeBrowser {
        return browser;
      }
      async unpublishAll(): Promise<void> {}
      destroy(callback?: () => void): void {
        callback?.();
      }
    }
    vi.doMock("bonjour-service", () => ({ Bonjour: FakeBonjour }));
    const discovery = createBonjourDiscovery();
    const peers: DiscoveredPeer[] = [];

    discovery.start(
      { port: 52_100, fingerprint: "a".repeat(64), deviceName: "Local" },
      (peer) => peers.push(peer),
      () => {},
    );
    await vi.dynamicImportSettled();

    const thrown: unknown[] = [];
    setTimeout(() => {
      try {
        mdnsErrorCallback(new Error("network interface disappeared"));
      } catch (error) {
        thrown.push(error);
      }
    }, 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(thrown).toEqual([]);
    browser.emit("up", {
      name: "Remote",
      port: 52_101,
      addresses: ["192.0.2.10"],
      txt: { fp: "b".repeat(64) },
    });
    expect(peers.map((peer) => peer.name)).toEqual(["Remote"]);

    await discovery.stop();
  });

  it("contains emitted mDNS socket errors and removes its listener on stop", async () => {
    vi.useFakeTimers();
    const mdns = new EventEmitter();
    const browser = new FakeBrowser();
    let listenersDuringPublish = 0;
    class FakeBonjour {
      server = { mdns };
      publish(): void {
        listenersDuringPublish = mdns.listenerCount("error");
      }
      find(): FakeBrowser {
        return browser;
      }
      async unpublishAll(): Promise<void> {}
      destroy(callback?: () => void): void {
        callback?.();
      }
    }
    vi.doMock("bonjour-service", () => ({ Bonjour: FakeBonjour }));
    const discovery = createBonjourDiscovery();
    const peers: DiscoveredPeer[] = [];

    discovery.start(
      { port: 52_100, fingerprint: "a".repeat(64), deviceName: "Local" },
      (peer) => peers.push(peer),
      () => {},
    );
    await vi.dynamicImportSettled();

    expect(listenersDuringPublish).toBe(1);
    const thrown: unknown[] = [];
    setTimeout(() => {
      try {
        mdns.emit("error", new Error("mDNS port unavailable"));
      } catch (error) {
        thrown.push(error);
      }
    }, 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(thrown).toEqual([]);
    browser.emit("up", {
      name: "Remote",
      port: 52_101,
      addresses: ["192.0.2.10"],
      txt: { fp: "b".repeat(64) },
    });
    expect(peers.map((peer) => peer.name)).toEqual(["Remote"]);

    await discovery.stop();
    expect(mdns.listenerCount("error")).toBe(0);
  });

  it("rejects malformed advertised fingerprints before peer callbacks", async () => {
    const browser = new FakeBrowser();
    class FakeBonjour {
      server = { mdns: new EventEmitter() };
      publish(): void {}
      find(): FakeBrowser {
        return browser;
      }
      async unpublishAll(): Promise<void> {}
      destroy(callback?: () => void): void {
        callback?.();
      }
    }
    vi.doMock("bonjour-service", () => ({ Bonjour: FakeBonjour }));
    const discovery = createBonjourDiscovery();
    const peers: DiscoveredPeer[] = [];
    const peersDown: string[] = [];

    discovery.start(
      { port: 52_100, fingerprint: "a".repeat(64), deviceName: "Local" },
      (peer) => peers.push(peer),
      (fingerprint) => peersDown.push(fingerprint),
    );
    await vi.dynamicImportSettled();

    for (const fingerprint of ["short", "B".repeat(64), "g".repeat(64), 42]) {
      const service = {
        name: "Malformed",
        port: 52_101,
        addresses: ["192.0.2.10"],
        txt: { fp: fingerprint },
      };
      browser.emit("up", service);
      browser.emit("down", service);
    }
    expect(peers).toEqual([]);
    expect(peersDown).toEqual([]);

    const validFingerprint = "b".repeat(64);
    const validService = {
      name: "Valid",
      port: 52_101,
      addresses: ["192.0.2.11"],
      txt: { fp: validFingerprint },
    };
    browser.emit("up", validService);
    browser.emit("down", validService);
    expect(peers.map((peer) => peer.fingerprint)).toEqual([validFingerprint]);
    expect(peersDown).toEqual([validFingerprint]);

    await discovery.stop();
  });

  it("cleans up a Bonjour instance when publishing fails and permits a retry", async () => {
    vi.useFakeTimers();
    const unpublishAll = vi.fn();
    const destroy = vi.fn();
    const find = vi.fn(() => new FakeBrowser());
    const publish = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("publish failed");
      })
      .mockImplementation(() => {});
    class FakeBonjour {
      publish = publish;
      find = find;
      unpublishAll = unpublishAll;
      destroy = destroy;
    }
    vi.doMock("bonjour-service", () => ({ Bonjour: FakeBonjour }));
    const discovery = createBonjourDiscovery();
    const advertise = { port: 52_100, fingerprint: "a".repeat(64), deviceName: "Local" };

    discovery.start(advertise, () => {}, () => {});
    await vi.dynamicImportSettled();

    expect(unpublishAll).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    discovery.start(advertise, () => {}, () => {});
    await vi.dynamicImportSettled();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await discovery.stop();
  });

  it("cleans up when the initial browser cannot be created or configured", async () => {
    vi.useFakeTimers();
    const browsers: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
    const unpublishAll = vi.fn();
    const destroy = vi.fn();
    let failure: "find" | "on" = "find";
    class FakeBonjour {
      publish(): void {}
      find(): FakeBrowser {
        if (failure === "find") throw new Error("find failed");
        const browser = new FakeBrowser();
        browser.on = vi.fn(() => {
          throw new Error("listener setup failed");
        });
        browsers.push(browser);
        return browser;
      }
      unpublishAll = unpublishAll;
      destroy = destroy;
    }
    vi.doMock("bonjour-service", () => ({ Bonjour: FakeBonjour }));
    const advertise = { port: 52_100, fingerprint: "a".repeat(64), deviceName: "Local" };

    for (const nextFailure of ["find", "on"] as const) {
      failure = nextFailure;
      const discovery = createBonjourDiscovery();
      discovery.start(advertise, () => {}, () => {});
      await vi.dynamicImportSettled();

      expect(vi.getTimerCount()).toBe(0);
      await discovery.stop();
    }

    expect(unpublishAll).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(browsers[0]?.stop).toHaveBeenCalledOnce();
  });

  it("contains a refresh failure, ignores the retired browser, and recovers", async () => {
    vi.useFakeTimers();
    const browsers: FakeBrowser[] = [];
    const find = vi.fn(() => {
      if (find.mock.calls.length === 2) throw new Error("refresh failed");
      const browser = new FakeBrowser();
      browsers.push(browser);
      return browser;
    });
    class FakeBonjour {
      publish(): void {}
      find = find;
      async unpublishAll(): Promise<void> {}
      destroy(): void {}
    }
    vi.doMock("bonjour-service", () => ({ Bonjour: FakeBonjour }));
    const discovery = createBonjourDiscovery();
    const peers: DiscoveredPeer[] = [];

    discovery.start(
      { port: 52_100, fingerprint: "a".repeat(64), deviceName: "Local" },
      (peer) => peers.push(peer),
      () => {},
    );
    await vi.dynamicImportSettled();

    await vi.advanceTimersByTimeAsync(60_000);
    browsers[0]?.emit("up", {
      name: "Retired",
      port: 52_101,
      addresses: ["192.0.2.10"],
      txt: { fp: "b".repeat(64) },
    });
    expect(peers).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(find).toHaveBeenCalledTimes(3);
    browsers[1]?.emit("up", {
      name: "Recovered",
      port: 52_101,
      addresses: ["192.0.2.11"],
      txt: { fp: "b".repeat(64) },
    });
    expect(peers.map((peer) => peer.name)).toEqual(["Recovered"]);

    await discovery.stop();
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
