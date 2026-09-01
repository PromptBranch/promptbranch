/**
 * LAN peer discovery behind a small injectable interface: mDNS advertise +
 * browse via bonjour-service. Tests inject a fake; the desktop app uses the
 * real one. VPN / mDNS-hostile networks bypass this via manual addresses.
 */

export interface DiscoveredPeer {
  /** Advertised certificate fingerprint (TXT record). */
  fingerprint: string;
  name: string;
  address: string;
  port: number;
}

export interface Discovery {
  start(
    advertise: { port: number; fingerprint: string; deviceName: string },
    onPeer: (peer: DiscoveredPeer) => void,
    onPeerDown: (fingerprint: string) => void,
  ): void;
  stop(): Promise<void>;
}

export const SYNC_SERVICE_TYPE = "promptbranch";

// bonjour-service 1.4.4 does not replace a cached service when only its
// A/AAAA records change. A fresh browser periodically drops that cache so a
// peer that kept the same service name and port after DHCP can be rediscovered.
const ADDRESS_REFRESH_MS = 60_000;

export function createBonjourDiscovery(): Discovery {
  let bonjour: import("bonjour-service").Bonjour | null = null;
  let browser: import("bonjour-service").Browser | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let lifecycleGeneration = 0;
  let activeGeneration: number | null = null;

  const disposeResources = async (
    ownedBonjour: import("bonjour-service").Bonjour | null,
    ownedBrowser: import("bonjour-service").Browser | null,
  ) => {
    // A broken mDNS stack must not prevent manual sync or the remaining cleanup.
    try {
      ownedBrowser?.stop();
    } catch {}
    try {
      await ownedBonjour?.unpublishAll();
    } catch {}
    try {
      ownedBonjour?.destroy();
    } catch {}
  };

  return {
    start(advertise, onPeer, onPeerDown) {
      if (activeGeneration !== null) return;
      lifecycleGeneration += 1;
      const generation = lifecycleGeneration;
      activeGeneration = generation;
      void import("bonjour-service").then(({ Bonjour }) => {
        if (activeGeneration !== generation) return;
        let instance: import("bonjour-service").Bonjour | null = null;
        const readPeer = (service: unknown): DiscoveredPeer | null => {
          const svc = service as {
            name?: string;
            port?: number;
            addresses?: string[];
            host?: string;
            txt?: Record<string, string>;
          };
          const fingerprint = svc.txt?.["fp"];
          if (!fingerprint || fingerprint === advertise.fingerprint) return null;
          const address = svc.addresses?.find((a) => !a.includes(":")) ?? svc.host ?? "";
          if (!address || !svc.port) return null;
          return { fingerprint, name: svc.name ?? "Unknown device", address, port: svc.port };
        };
        const browse = (): boolean => {
          const ownedInstance = instance;
          if (
            !ownedInstance ||
            activeGeneration !== generation ||
            bonjour !== ownedInstance
          ) {
            return false;
          }
          const previousBrowser = browser;
          try {
            previousBrowser?.stop();
          } catch {
            return false;
          }
          if (browser === previousBrowser) browser = null;
          let nextBrowser: import("bonjour-service").Browser;
          try {
            nextBrowser = ownedInstance.find({ type: SYNC_SERVICE_TYPE });
          } catch {
            return false;
          }
          browser = nextBrowser;
          const ownsBrowser = () =>
            activeGeneration === generation &&
            bonjour === instance &&
            browser === nextBrowser;
          const refreshPeer = (service: unknown) => {
            if (!ownsBrowser()) return;
            const peer = readPeer(service);
            if (peer) onPeer(peer);
          };
          try {
            nextBrowser.on("up", refreshPeer);
            nextBrowser.on("srv-update", refreshPeer);
            nextBrowser.on("down", (service: unknown) => {
              if (!ownsBrowser()) return;
              const svc = service as { txt?: Record<string, string> };
              const fingerprint = svc.txt?.["fp"];
              if (fingerprint && fingerprint !== advertise.fingerprint) onPeerDown(fingerprint);
            });
          } catch {
            if (browser === nextBrowser) browser = null;
            try {
              nextBrowser.stop();
            } catch {
              // Discovery is optional; cleanup remains best-effort.
            }
            return false;
          }
          return true;
        };
        try {
          instance = new Bonjour();
          bonjour = instance;
          instance.publish({
            name: `PromptBranch ${advertise.deviceName}`,
            type: SYNC_SERVICE_TYPE,
            port: advertise.port,
            txt: { fp: advertise.fingerprint, v: "1" },
          });
          if (!browse()) throw new Error("Failed to start Bonjour browser");
          refreshTimer = setInterval(browse, ADDRESS_REFRESH_MS);
          refreshTimer.unref?.();
        } catch {
          if (activeGeneration === generation) {
            activeGeneration = null;
            if (refreshTimer) clearInterval(refreshTimer);
            refreshTimer = null;
          }
          const ownsInstance = instance !== null && bonjour === instance;
          const failedBrowser = ownsInstance ? browser : null;
          if (ownsInstance) {
            bonjour = null;
            browser = null;
          }
          void disposeResources(instance, failedBrowser);
        }
      }).catch(() => {
        if (activeGeneration === generation) activeGeneration = null;
      });
    },
    async stop() {
      activeGeneration = null;
      lifecycleGeneration += 1;
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
      const ownedBrowser = browser;
      const ownedBonjour = bonjour;
      browser = null;
      bonjour = null;
      await disposeResources(ownedBonjour, ownedBrowser);
    },
  };
}
