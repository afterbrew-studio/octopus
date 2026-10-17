import { expect, it, mock } from "bun:test";

let receive: (attempt: string) => void;
const published: string[] = [];
mock.module("@/lib/cancel-bus", () => ({
  onCancel: (_kind: string, handler: typeof receive) => { receive = handler; },
  publishCancel: (_kind: string, attempt: string) => { published.push(attempt); },
}));
const { createAbortController, clearAbortController, abortIndexing } = await import("@/lib/indexing-abort");

it("keeps delayed cancellation and cleanup scoped to their attempt", () => {
  const old = createAbortController("old-attempt");
  const replacement = createAbortController("replacement-attempt");
  expect(abortIndexing("old-attempt")).toBe(true);
  expect(old.signal.aborted).toBe(true);
  expect(replacement.signal.aborted).toBe(false);
  receive("old-attempt");
  clearAbortController("old-attempt");
  expect(abortIndexing("replacement-attempt")).toBe(true);
  expect(replacement.signal.aborted).toBe(true);
  expect(published).toEqual(["old-attempt", "replacement-attempt"]);
});
