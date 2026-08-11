const STREAM_PORT = "mt-translation-stream-v1";
const INACTIVITY_TIMEOUT_MS = 45_000;

export function installNovelStreamClient(runtime) {
  const activePorts = new Set();

  function cancelNovelTranslationStream(taskId = "") {
    let cancelled = false;
    for (const entry of [...activePorts]) {
      if (entry.taskId === taskId || !taskId) {
        entry.port.postMessage({ type: "cancel", taskId: entry.taskId });
        try { entry.port.disconnect(); } catch { /* Port 已关闭 */ }
        activePorts.delete(entry);
        cancelled = true;
      }
    }
    return cancelled;
  }
  runtime.cancelNovelTranslationStream = cancelNovelTranslationStream;

  function runNovelTranslationStream(request, onEvent) {
    if (!chrome.runtime?.connect) return Promise.reject(new Error("当前浏览器不支持扩展 Port"));
    const taskId = String(request.taskId || "");
    const port = chrome.runtime.connect({ name: STREAM_PORT });
    const entry = { taskId, port };
    activePorts.add(entry);
    return new Promise((resolve, reject) => {
      let finished = false;
      let timer = 0;
      let protocolErrors = 0;
      let eventQueue = Promise.resolve();
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("流式翻译长时间没有响应")), INACTIVITY_TIMEOUT_MS);
      };
      const finish = (error = null, result = null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        activePorts.delete(entry);
        try { port.disconnect(); } catch { /* Port 已关闭 */ }
        if (error) reject(error);
        else eventQueue.then(() => resolve({ ...result, protocolErrors }), reject);
      };
      port.onMessage.addListener(event => {
        if (String(event?.taskId || "") !== taskId) return;
        resetTimer();
        if (event.type === "protocol_error") {
          protocolErrors += 1;
          return;
        }
        if (event.type === "stream_error") {
          finish(new Error(String(event.error || "流式翻译连接中断")));
          return;
        }
        if (event.type === "paragraph" || event.type === "progress") {
          eventQueue = eventQueue.then(() => onEvent?.(event));
        }
        if (event.type === "done") finish(null, event);
      });
      port.onDisconnect.addListener(() => {
        if (!finished) finish(new Error(String(chrome.runtime.lastError?.message || "流式翻译连接已断开")));
      });
      resetTimer();
      port.postMessage({ type: "start", request });
    });
  }
  runtime.runNovelTranslationStream = runNovelTranslationStream;
}
