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
  ): void;
  stop(): Promise<void>;
}

export const SYNC_SERVICE_TYPE = "promptbranch";

export function createBonjourDiscovery(): Discovery {
  let bonjour: import("bonjour-service").Bonjour | null = null;
  let browser: import("bonjour-service").Browser | null = null;
  let stopped = true;

  return {
    start(advertise, onPeer) {
      if (!stopped) return;
      stopped = false;
      void import("bonjour-service").then(({ Bonjour }) => {
        if (stopped) return;
        bonjour = new Bonjour();
        bonjour.publish({
          name: `PromptBranch ${advertise.deviceName}`,
          type: SYNC_SERVICE_TYPE,
          port: advertise.port,
          txt: { fp: advertise.fingerprint, v: "1" },
        });
        browser = bonjour.find({ type: SYNC_SERVICE_TYPE });
        browser.on("up", (service: unknown) => {
          const svc = service as {
            name?: string;
            port?: number;
            addresses?: string[];
            host?: string;
            txt?: Record<string, string>;
          };
          const fingerprint = svc.txt?.["fp"];
          if (!fingerprint || fingerprint === advertise.fingerprint) return;
          const address = svc.addresses?.find((a) => !a.includes(":")) ?? svc.host ?? "";
          if (!address || !svc.port) return;
          onPeer({ fingerprint, name: svc.name ?? "Unknown device", address, port: svc.port });
        });
      });
    },
    async stop() {
      stopped = true;
      try {
        browser?.stop();
        await bonjour?.unpublishAll();
        bonjour?.destroy();
      } catch {
        // Shutdown best-effort.
      }
      bonjour = null;
      browser = null;
    },
  };
}
