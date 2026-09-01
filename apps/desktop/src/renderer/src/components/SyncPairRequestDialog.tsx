import { useEffect, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { syncPairRequestEventSchema, type SyncPairRequestEvent } from "../../../shared/ipc.js";

/**
 * Global pairing gate: another device on the network entered this device's
 * pairing code and introduced itself. Accept pins its TLS fingerprint;
 * decline refuses the connection. The fingerprint is verified against the
 * live TLS certificate in the main process — never against message content.
 */
export function SyncPairRequestDialog() {
  const [request, setRequest] = useState<SyncPairRequestEvent | null>(null);

  useEffect(() => {
    const unsubscribe = window.promptBuilder.sync.onPairRequest((raw) => {
      // Push payloads are validated here, like ai:run-progress events.
      const parsed = syncPairRequestEventSchema.safeParse(raw);
      if (parsed.success) setRequest(parsed.data);
    });
    return unsubscribe;
  }, []);

  const respond = (accept: boolean) => {
    if (request) void window.promptBuilder.sync.respondPairing({ requestId: request.requestId, accept });
    setRequest(null);
  };

  return (
    <AlertDialog.Root open={request !== null} onOpenChange={(open) => !open && respond(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
        <AlertDialog.Content className="pb-dialog fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line-strong bg-panel p-5 shadow-2xl shadow-black/50 focus:outline-none">
          <AlertDialog.Title className="text-[14px] font-semibold text-ink">Pair with this device?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-relaxed text-ink-dim">
            <span className="font-medium text-ink">{request?.name}</span> wants to sync this library. Its identity
            fingerprint is <span className="font-mono text-ink">{request?.fingerprintShort}</span>. Accepting lets it
            receive and send every prompt in this library.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Action
              onClick={() => respond(false)}
              className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              Decline
            </AlertDialog.Action>
            <AlertDialog.Action
              onClick={() => respond(true)}
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong"
            >
              Accept
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
