/**
 * Shared in-flight request subscription model.
 *
 * Multiple tasks may merge into one underlying request (keyed by translation
 * fingerprint). Each taskId subscribes; canceling one task only removes its
 * subscription, and the shared request is aborted only when no subscriber is
 * left — so canceling task A never kills the merged request that task B still
 * needs. `notifyUnsubscribed` lets the batch owner decide when to abort the
 * shared controller.
 */

export function createInflightEntry() {
  const entry = {
    promise: null,
    controller: null,
    resolve: null,
    reject: null,
    subscribers: new Set(),
    bindings: [],
    settled: false,
    notifyUnsubscribed: null
  };
  entry.promise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });
  entry.controller = new AbortController();
  return entry;
}

export function subscribeInflight(entry, taskId, signal) {
  if (!entry) return;
  if (taskId) entry.subscribers.add(taskId);
  if (!signal) return;
  const onAbort = () => {
    if (taskId) entry.subscribers.delete(taskId);
    entry.notifyUnsubscribed?.();
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  entry.bindings.push({ signal, onAbort });
}

export function cleanupInflight(entry) {
  if (!entry) return;
  entry.settled = true;
  entry.notifyUnsubscribed = null;
  for (const binding of entry.bindings) {
    binding.signal.removeEventListener("abort", binding.onAbort);
  }
  entry.bindings = [];
  entry.subscribers.clear();
}
