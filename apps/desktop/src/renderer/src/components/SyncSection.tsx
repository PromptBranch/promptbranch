import { useState } from "react";
import { Laptop, RefreshCw, Trash2 } from "lucide-react";
import { useAppMutation, useSyncStatus } from "../hooks/use-data";

const inputClass =
  "w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";

const ghostButton =
  "shrink-0 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-40";

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <span className="text-[12px] font-medium text-ink-dim">{children}</span>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const STATE_LABEL: Record<string, string> = {
  connecting: "waiting",
  syncing: "syncing",
  steady: "synced",
  error: "error",
  offline: "offline",
};

const STATE_DOT: Record<string, string> = {
  connecting: "bg-ink-faint",
  syncing: "bg-blue-400",
  steady: "bg-emerald-500",
  error: "bg-red-500",
  offline: "bg-red-500",
};

/**
 * Settings → Sync: enable P2P sync, name this device, add devices with a
 * pairing code (nearby list or manual address for VPNs), manage and forget
 * paired devices. Data syncs directly between your devices over the local
 * network — there is no server.
 */
export function SyncSection() {
  const { data: status } = useSyncStatus();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [manualAddress, setManualAddress] = useState("");
  const [manualPort, setManualPort] = useState("");
  const [code, setCode] = useState("");
  const [pairError, setPairError] = useState<string | null>(null);

  const setEnabled = useAppMutation((enabled: boolean) => window.promptBuilder.sync.setEnabled(enabled), {
    quiet: true,
    invalidateKeys: [["sync-status"]],
  });
  const setDeviceName = useAppMutation((name: string) => window.promptBuilder.sync.setDeviceName(name), {
    toast: "Device name saved",
    invalidateKeys: [["sync-status"]],
    onSuccess: () => setNameDraft(null),
  });
  const setListenPort = useAppMutation((port: number) => window.promptBuilder.sync.setListenPort(port), {
    toast: "Listening port saved",
    invalidateKeys: [["sync-status"]],
    onSuccess: () => setPortDraft(null),
  });
  const beginPairing = useAppMutation(() => window.promptBuilder.sync.beginPairing(), {
    quiet: true,
    invalidateKeys: [["sync-status"]],
  });
  const cancelPairing = useAppMutation(() => window.promptBuilder.sync.cancelPairing(), {
    quiet: true,
    invalidateKeys: [["sync-status"]],
  });
  const forget = useAppMutation((fingerprint: string) => window.promptBuilder.sync.forgetDevice(fingerprint), {
    toast: "Device forgotten",
    invalidateKeys: [["sync-status"]],
  });
  const syncNow = useAppMutation(() => window.promptBuilder.sync.now(), {
    quiet: true,
    invalidateKeys: [["sync-status"]],
  });

  const pair = useAppMutation(
    (input: { address: string; port: number; code: string }) => window.promptBuilder.sync.pairWithCode(input),
    {
      quiet: true,
      invalidateKeys: [["sync-status"]],
      onSuccess: (result) => {
        if (result.ok) {
          setCode("");
          setManualAddress("");
          setManualPort("");
          setPairError(null);
        } else {
          setPairError(result.error ?? "Pairing failed");
        }
      },
      onError: (err) => setPairError(err.message),
    },
  );

  if (!status) return null;
  const portValue = portDraft ?? (status.listenPort === null ? "" : String(status.listenPort));
  const portNumber = Number(portValue);
  const portValid =
    /^\d+$/.test(portValue) &&
    Number.isInteger(portNumber) &&
    portNumber >= 1_024 &&
    portNumber <= 65_535;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <FieldLabel hint="Sync directly with your other computers over the local network. No server, no account — changes travel between paired devices only.">
          Device-to-device sync
        </FieldLabel>
        <button
          type="button"
          role="switch"
          aria-checked={status.enabled}
          onClick={() => setEnabled.mutate(!status.enabled)}
          className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
            status.enabled ? "border-accent/60 bg-accent/30" : "border-line bg-app"
          }`}
        >
          <span
            className={`ml-0.5 h-4 w-4 rounded-full transition-transform ${
              status.enabled ? "translate-x-4 bg-accent" : "translate-x-0 bg-ink-faint"
            }`}
          />
        </button>
      </div>

      {status.enabled && (
        <>
          <div className="space-y-2">
            <FieldLabel hint="Shown on your other devices when pairing and in the sync status.">
              This device
            </FieldLabel>
            <div className="flex items-center gap-2">
              <input
                aria-label="Device name"
                value={nameDraft ?? status.deviceName}
                onChange={(e) => setNameDraft(e.target.value)}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => nameDraft && setDeviceName.mutate(nameDraft)}
                disabled={nameDraft === null || nameDraft.trim().length === 0 || setDeviceName.isPending}
                className={ghostButton}
              >
                Rename
              </button>
            </div>
            <p className="text-[11px] text-ink-faint">
              {status.fingerprintShort ? `Identity ${status.fingerprintShort}` : "Generating identity…"}
              {" · "}
              {status.pendingDirty > 0 ? `${status.pendingDirty} change${status.pendingDirty === 1 ? "" : "s"} waiting to sync` : `Last synced ${relativeTime(status.lastSyncedAt)}`}
            </p>
            <div className="flex items-center gap-2">
              <input
                aria-label="Listening port"
                inputMode="numeric"
                value={portValue}
                onChange={(e) => setPortDraft(e.target.value.replace(/[^0-9]/g, ""))}
                className="w-28 rounded-md border border-line bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
              <button
                type="button"
                aria-label="Save port"
                onClick={() => setListenPort.mutate(portNumber)}
                disabled={portDraft === null || !portValid || setListenPort.isPending}
                className={ghostButton}
              >
                Save port
              </button>
            </div>
            {portDraft !== null && !portValid && (
              <p className="text-[11px] text-red-500">Use a port from 1024 to 65535.</p>
            )}
            {status.listenError && <p className="text-[12px] text-red-500">{status.listenError}</p>}
          </div>

          <div className="space-y-2">
            <FieldLabel hint="Devices on this network appear below. On the other device, open Settings → Sync and press “Show pairing code”, then type that code here.">
              Add a device
            </FieldLabel>

            {status.pairingActive ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2.5">
                <div>
                  <p className="text-[12px] font-medium text-ink">Pairing window open</p>
                  <p className="mt-0.5 font-mono text-[15px] tracking-wider text-ink">{status.pairingCode}</p>
                  {status.listenPort !== null && (
                    <p className="mt-0.5 text-[11px] text-ink-faint">Port {status.listenPort}</p>
                  )}
                </div>
                <button type="button" onClick={() => cancelPairing.mutate()} className={ghostButton}>
                  Close
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => beginPairing.mutate()} className={ghostButton}>
                Show pairing code
              </button>
            )}

            <div className="flex items-center gap-2">
              <input
                aria-label="Pairing code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX"
                className={`${inputClass} font-mono tracking-wider`}
              />
            </div>

            {status.nearby.length > 0 && (
              <div className="space-y-1.5">
                {status.nearby.map((device) => (
                  <div
                    key={device.fingerprint}
                    className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-ink">{device.name}</span>
                      <span className="block text-[11px] text-ink-faint">
                        {device.address}:{device.port}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={code.trim().length === 0 || pair.isPending}
                      onClick={() => pair.mutate({ address: device.address, port: device.port, code: code.trim() })}
                      className={ghostButton}
                    >
                      Pair
                    </button>
                  </div>
                ))}
              </div>
            )}

            <details className="text-[12px] text-ink-dim">
              <summary className="cursor-pointer select-none text-ink-faint">Pair by address (VPNs, manual setup)</summary>
              <p className="mt-1 text-[11px] text-ink-faint">
                Enter the address and listening port shown in Settings → Sync on the other device.
                {status.listenPort !== null && ` This device uses port ${status.listenPort}.`}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  aria-label="Device address"
                  value={manualAddress}
                  onChange={(e) => setManualAddress(e.target.value)}
                  placeholder="192.168.1.23 or hostname"
                  className={inputClass}
                />
                <input
                  aria-label="Device port"
                  value={manualPort}
                  onChange={(e) => setManualPort(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="Port"
                  className="w-20 rounded-md border border-line bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
                <button
                  type="button"
                  disabled={
                    code.trim().length === 0 || manualAddress.trim().length === 0 || manualPort.length === 0 || pair.isPending
                  }
                  onClick={() =>
                    pair.mutate({ address: manualAddress.trim(), port: Number(manualPort), code: code.trim() })
                  }
                  className={ghostButton}
                >
                  Pair
                </button>
              </div>
            </details>

            {pairError && <p className="text-[12px] text-red-500">{pairError}</p>}
          </div>

          {status.peers.length > 0 && (
            <div className="space-y-2">
              <FieldLabel>Paired devices</FieldLabel>
              <div className="space-y-1.5">
                {status.peers.map((peer) => (
                  <div
                    key={peer.fingerprint}
                    className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[peer.state] ?? "bg-ink-faint"}`} />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] text-ink">{peer.name}</span>
                        <span className="block text-[11px] text-ink-faint">
                          {STATE_LABEL[peer.state] ?? peer.state} · seen {relativeTime(peer.lastSeen)}
                        </span>
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Forget ${peer.name}`}
                      onClick={() => forget.mutate(peer.fingerprint)}
                      className="shrink-0 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-red-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
              <Laptop size={13} />
              {status.listening
                ? `Listening on port ${status.listenPort}`
                : "Listener not running — try re-enabling sync"}
            </span>
            <button type="button" onClick={() => syncNow.mutate()} disabled={syncNow.isPending} className={ghostButton}>
              <span className="flex items-center gap-1.5">
                <RefreshCw size={12} className={syncNow.isPending ? "animate-spin" : undefined} />
                Sync now
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
