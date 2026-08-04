import assert from "node:assert/strict";
import test from "node:test";
import { installTranslationTaskCancel } from "../extension/src/background/modules/translation-task-cancel.js";

function makeRuntime() {
  const runtime = {};
  installTranslationTaskCancel(runtime);
  return runtime;
}

test("register + cancel aborts the controller and cleans the map", () => {
  const runtime = makeRuntime();
  const controller = new AbortController();
  runtime.registerTaskAbort("task-1", controller);
  assert.equal(runtime.translationAbortControllers.size, 1);
  assert.equal(controller.signal.aborted, false);
  const cancelled = runtime.cancelTranslationTask("task-1");
  assert.equal(cancelled, 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(runtime.translationAbortControllers.size, 0, "map must be cleaned after cancel");
});

test("unregister on completion cleans the map without aborting", () => {
  const runtime = makeRuntime();
  const controller = new AbortController();
  runtime.registerTaskAbort("task-2", controller);
  runtime.unregisterTaskAbort("task-2", controller);
  assert.equal(runtime.translationAbortControllers.size, 0);
  assert.equal(controller.signal.aborted, false);
});

test("multiple controllers per task are all aborted and released", () => {
  const runtime = makeRuntime();
  const first = new AbortController();
  const second = new AbortController();
  runtime.registerTaskAbort("task-3", first);
  runtime.registerTaskAbort("task-3", second);
  assert.equal(runtime.cancelTranslationTask("task-3"), 2);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(runtime.translationAbortControllers.size, 0);
});

test("abort listener removes the controller from the map even without explicit cancel", () => {
  const runtime = makeRuntime();
  const controller = new AbortController();
  runtime.registerTaskAbort("task-4", controller);
  controller.abort();
  // 清理发生在微任务监听回调中，等待一轮
  return Promise.resolve().then(() => {
    assert.equal(runtime.translationAbortControllers.size, 0);
  });
});

test("cancel message handler returns counts and is idempotent", async () => {
  const runtime = makeRuntime();
  const controller = new AbortController();
  runtime.registerTaskAbort("task-5", controller);
  const result = await runtime.handleCancelTranslationTask({ taskId: "task-5" });
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, 1);
  const again = await runtime.handleCancelTranslationTask({ taskId: "task-5" });
  assert.equal(again.cancelled, 0);
});

test("isAbortError distinguishes cancellation from real errors", () => {
  const runtime = makeRuntime();
  assert.equal(runtime.isAbortError(new DOMException("aborted", "AbortError")), true);
  assert.equal(runtime.isAbortError(new Error("timeout")), false);
  assert.equal(runtime.isAbortError(null), false);
});

test("tab-close cleanup cancels every task registered for that tab", () => {
  const runtime = makeRuntime();
  const tab1Task = new AbortController();
  const tab1Other = new AbortController();
  const tab2Task = new AbortController();
  runtime.registerTaskAbort("t1-a", tab1Task, 101);
  runtime.registerTaskAbort("t1-b", tab1Other, 101);
  runtime.registerTaskAbort("t2-a", tab2Task, 202);
  assert.equal(runtime.translationTasksByTab.get(101).size, 2);
  const cancelled = runtime.cancelTasksForTab(101);
  assert.equal(cancelled, 2);
  assert.equal(tab1Task.signal.aborted, true);
  assert.equal(tab1Other.signal.aborted, true);
  assert.equal(tab2Task.signal.aborted, false, "其他 tab 的任务不受影响");
  assert.equal(runtime.translationAbortControllers.size, 1);
  assert.equal(runtime.translationTasksByTab.has(101), false);
  // 再次取消该 tab：幂等
  assert.equal(runtime.cancelTasksForTab(101), 0);
});

test("registering with a tabId records the mapping and cleans on abort", () => {
  const runtime = makeRuntime();
  const controller = new AbortController();
  runtime.registerTaskAbort("tabbed-1", controller, 303);
  assert.equal(runtime.translationTasksByTab.get(303).has("tabbed-1"), true);
  controller.abort();
  return Promise.resolve().then(() => {
    assert.equal(runtime.translationAbortControllers.size, 0);
    assert.equal(runtime.translationTasksByTab.has(303), false);
  });
});

test("install without chrome.tabs is safe (no listener crash)", () => {
  const runtime = makeRuntime();
  assert.equal(typeof runtime.cancelTasksForTab, "function");
  assert.equal(runtime.cancelTasksForTab(999), 0);
});
