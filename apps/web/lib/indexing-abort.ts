import { onCancel, publishCancel } from "./cancel-bus";

const controllers = new Map<string, AbortController>();

let listenerRegistered = false;
function ensureListener() {
  if (listenerRegistered) return;
  listenerRegistered = true;
  onCancel("indexing", (indexAttemptId) => {
    const c = controllers.get(indexAttemptId);
    if (!c) return;
    c.abort();
    controllers.delete(indexAttemptId);
  });
}

export function createAbortController(indexAttemptId: string): AbortController {
  ensureListener();
  const controller = new AbortController();
  controllers.set(indexAttemptId, controller);
  return controller;
}

export function abortIndexing(indexAttemptId: string): boolean {
  publishCancel("indexing", indexAttemptId);
  const controller = controllers.get(indexAttemptId);
  if (!controller) return false;
  controller.abort();
  controllers.delete(indexAttemptId);
  return true;
}

export function clearAbortController(indexAttemptId: string) {
  controllers.delete(indexAttemptId);
}
