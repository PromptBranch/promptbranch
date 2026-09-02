import type { QueryClient } from "@tanstack/react-query";

export interface PromptDraftWrite {
  value: string | null;
  persist: () => Promise<void>;
  onAccepted: () => void;
  onRejected: (error: unknown) => void;
}

interface PromptDraftQueue {
  inFlight: boolean;
  queued: PromptDraftWrite | null;
}

const queuesByClient = new WeakMap<QueryClient, Map<string, PromptDraftQueue>>();

function runWrite(
  queues: Map<string, PromptDraftQueue>,
  promptId: string,
  queue: PromptDraftQueue,
  write: PromptDraftWrite,
) {
  queue.inFlight = true;
  void write.persist().then(
    () => {
      queue.inFlight = false;
      const queued = queue.queued;
      queue.queued = null;
      if (queued && queued.value !== write.value) {
        runWrite(queues, promptId, queue, queued);
        return;
      }
      // An equivalent request from a newer component lifetime owns the UI
      // continuation even though the completed persistence satisfies both.
      (queued ?? write).onAccepted();
      if (!queue.inFlight && queue.queued === null) queues.delete(promptId);
    },
    (error) => {
      queue.inFlight = false;
      const queued = queue.queued;
      queue.queued = null;
      write.onRejected(error);
      if (queued) runWrite(queues, promptId, queue, queued);
      else queues.delete(promptId);
    },
  );
}

/**
 * Serializes draft writes for one prompt across EditorTab lifetimes. While a
 * write is pending, repeated requests coalesce to the newest desired value.
 */
export function enqueuePromptDraftWrite(
  queryClient: QueryClient,
  promptId: string,
  write: PromptDraftWrite,
): void {
  let queues = queuesByClient.get(queryClient);
  if (!queues) {
    queues = new Map();
    queuesByClient.set(queryClient, queues);
  }
  let queue = queues.get(promptId);
  if (!queue) {
    queue = { inFlight: false, queued: null };
    queues.set(promptId, queue);
  }
  if (queue.inFlight) {
    queue.queued = write;
    return;
  }
  runWrite(queues, promptId, queue, write);
}
