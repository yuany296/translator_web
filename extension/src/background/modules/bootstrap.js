export function installBootstrap(runtime) {
  chrome.runtime.onConnect?.addListener(port => runtime.handleTranslationStreamPort?.(port));
  try {
    chrome.sidePanel?.setOptions?.({ enabled: true, path: "sidepanel.html" });
  } catch (error) {
    console.warn("[MangaTranslator] sidePanel.setOptions failed:", error);
  }
  chrome.runtime.onInstalled.addListener(async details => {
    try {
      await runtime.ensureDefaultSettings();
      await runtime.pruneExpiredTabStatuses();
      if (details && details.reason === "update") {
        await runtime.reinjectContentScriptsToOpenTabs();
      }
    } catch (error) {
      console.warn("[MangaTranslator] onInstalled init failed:", error);
    }
  });
  chrome.runtime.onStartup.addListener(async () => {
    try {
      await runtime.pruneExpiredTabStatuses();
    } catch (error) {
      console.warn("[MangaTranslator] onStartup init failed:", error);
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }
    runtime.handleMessage(message, sender).then(payload => sendResponse(payload)).catch(error => {
      const safeMessage = error && error.message ? error.message : "Unknown background error";
      sendResponse({
        ok: false,
        error: safeMessage
      });
    });
    return true;
  });
}
