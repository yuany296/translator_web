/**
 * Translation task cancellation protocol. The content script tags requests
 * with a taskId; the background registers an AbortController per taskId,
 * aborts it on CANCEL_TRANSLATION_TASK (or when a new task replaces an old
 * one), and cleans the Map on abort, completion and cancel. Tab-close cleanup
 * cancels every task of a closed tab. AbortError is never surfaced as a
 * user-facing error.
 */
export function installTranslationTaskCancel(runtime) {
  const abortControllers = new Map();
  runtime.translationAbortControllers = abortControllers;
  const tasksByTab = new Map();
  runtime.translationTasksByTab = tasksByTab;

  function registerTaskAbort(taskId, controller, tabId = 0) {
    if (!taskId || !controller) return;
    let list = abortControllers.get(taskId);
    if (!list) {
      list = new Set();
      abortControllers.set(taskId, list);
    }
    list.add(controller);
    if (tabId) {
      let taskIds = tasksByTab.get(tabId);
      if (!taskIds) {
        taskIds = new Set();
        tasksByTab.set(tabId, taskIds);
      }
      taskIds.add(taskId);
    }
    controller.signal.addEventListener("abort", () => {
      list.delete(controller);
      if (list.size === 0) abortControllers.delete(taskId);
      if (tabId) {
        const taskIds = tasksByTab.get(tabId);
        if (taskIds) {
          taskIds.delete(taskId);
          if (taskIds.size === 0) tasksByTab.delete(tabId);
        }
      }
    }, { once: true });
  }
  runtime.registerTaskAbort = registerTaskAbort;

  function unregisterTaskAbort(taskId, controller) {
    if (!taskId || !controller) return;
    const list = abortControllers.get(taskId);
    if (!list) return;
    list.delete(controller);
    if (list.size === 0) abortControllers.delete(taskId);
  }
  runtime.unregisterTaskAbort = unregisterTaskAbort;

  function cancelTranslationTask(taskId) {
    if (!taskId) return 0;
    const list = abortControllers.get(taskId);
    if (!list) return 0;
    let count = 0;
    for (const controller of [...list]) {
      controller.abort();
      count += 1;
    }
    abortControllers.delete(taskId);
    for (const [tabId, taskIds] of tasksByTab) {
      taskIds.delete(taskId);
      if (taskIds.size === 0) tasksByTab.delete(tabId);
    }
    return count;
  }
  runtime.cancelTranslationTask = cancelTranslationTask;

  function cancelTasksForTab(tabId) {
    const taskIds = tasksByTab.get(tabId);
    if (!taskIds) return 0;
    let count = 0;
    for (const taskId of [...taskIds]) count += cancelTranslationTask(taskId);
    return count;
  }
  runtime.cancelTasksForTab = cancelTasksForTab;

  function handleCancelTranslationTask(message = {}) {
    return Promise.resolve({ ok: true, cancelled: cancelTranslationTask(message && message.taskId) });
  }
  runtime.handleCancelTranslationTask = handleCancelTranslationTask;

  function isAbortError(error) {
    return !!(error && error.name === "AbortError");
  }
  runtime.isAbortError = isAbortError;

  // 标签页关闭时取消该 tab 的全部进行中任务（content script 无法自行发送取消）
  try {
    if (globalThis.chrome?.tabs?.onRemoved?.addListener) {
      globalThis.chrome.tabs.onRemoved.addListener(tabId => cancelTasksForTab(tabId));
    }
  } catch {
    // 测试或无 tabs 环境跳过
  }
}
