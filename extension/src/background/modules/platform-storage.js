export function installPlatformStorage(runtime) {
  async function transcodeBlob(blob, targetMime, quality) {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
      return null;
    }
    try {
      const bitmap = await createImageBitmap(blob);
      try {
        const maxSide = runtime.IMAGE_MAX_SIDE;
        const longestSide = Math.max(bitmap.width, bitmap.height);
        let targetWidth = bitmap.width;
        let targetHeight = bitmap.height;
        if (longestSide > maxSide) {
          const scale = maxSide / longestSide;
          targetWidth = Math.max(1, Math.round(bitmap.width * scale));
          targetHeight = Math.max(1, Math.round(bitmap.height * scale));
        }
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return null;
        }
        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        const options = {
          type: targetMime
        };
        if (typeof quality === "number") {
          options.quality = quality;
        }
        const converted = await canvas.convertToBlob(options);
        return converted || null;
      } finally {
        bitmap.close();
      }
    } catch {
      return null;
    }
  }
  runtime.transcodeBlob = transcodeBlob;
  function blobToDataUrl(blob, timeoutMs = runtime.BLOB_TO_DATA_URL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let reader = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback(value);
      };
      const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
      const timer = safeTimeoutMs > 0 ? setTimeout(() => {
        finish(reject, new Error(`Blob to data URL timed out after ${safeTimeoutMs}ms`));
        try {
          if (reader && typeof reader.abort === "function") reader.abort();
        } catch {
          // FileReader 可能已在完成和 timeout 的竞态中关闭。
        }
      }, safeTimeoutMs) : 0;
      try {
        reader = new FileReader();
        reader.onerror = () => finish(reject, new Error("Blob to data URL failed"));
        reader.onabort = () => finish(reject, new Error("Blob to data URL was aborted"));
        reader.onload = () => finish(resolve, reader.result);
        reader.readAsDataURL(blob);
      } catch (error) {
        finish(reject, error);
      }
    });
  }
  runtime.blobToDataUrl = blobToDataUrl;
  function safeJson(response) {
    return response.json().catch(() => null);
  }
  runtime.safeJson = safeJson;
  async function fetchJsonWithTimeout(endpoint, init, options = {}) {
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 1);
    const timeoutMessage = String(options.timeoutMessage || `Request timed out after ${timeoutMs}ms`);
    const controller = new AbortController();
    let timeoutId = 0;
    let timedOut = false;
    const timeout = new Promise((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });
    const request = (async () => {
      const response = await fetch(endpoint, {
        ...(init || {}),
        signal: controller.signal
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        // Abort 必须交给超时边界处理；普通 JSON 解析失败仍沿用原先的 null 语义。
        if (timedOut || error && error.name === "AbortError") {
          throw error;
        }
      }
      return {
        response,
        payload
      };
    })();
    try {
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (timedOut) {
        throw new Error(timeoutMessage);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  runtime.fetchJsonWithTimeout = fetchJsonWithTimeout;
  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, result => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result || {});
        }
      });
    });
  }
  runtime.storageGet = storageGet;
  function storageSet(value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(value, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }
  runtime.storageSet = storageSet;
  function storageRemove(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }
  runtime.storageRemove = storageRemove;
  async function reinjectContentScriptsToOpenTabs() {
    const tabs = await runtime.queryAllTabs();
    const tasks = tabs.filter(tab => runtime.isInjectableTab(tab)).map(async tab => {
      const tabId = Number(tab && tab.id);
      if (!Number.isInteger(tabId) || tabId < 0) {
        return;
      }
      try {
        await runtime.safeInsertCss(tabId, "styles.css");
        await runtime.safeExecuteScriptFiles(tabId, runtime.CONTENT_SCRIPT_FILES);
      } catch {
        // Ignore per-tab injection errors.
      }
    });
    await Promise.all(tasks);
  }
  runtime.reinjectContentScriptsToOpenTabs = reinjectContentScriptsToOpenTabs;
  function isInjectableTab(tab) {
    const url = String(tab && tab.url || "");
    if (!url) {
      return false;
    }
    return /^(https?:|file:|ftp:)/i.test(url);
  }
  runtime.isInjectableTab = isInjectableTab;
  function queryAllTabs() {
    return new Promise(resolve => {
      chrome.tabs.query({}, tabs => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        resolve(Array.isArray(tabs) ? tabs : []);
      });
    });
  }
  runtime.queryAllTabs = queryAllTabs;
  function safeExecuteScriptFiles(tabId, files) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript({
        target: {
          tabId,
          allFrames: true
        },
        files: [...files]
      }, () => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message || "executeScript failed";
          if (runtime.isSafeInjectError(message)) {
            resolve();
            return;
          }
          reject(new Error(message));
          return;
        }
        resolve();
      });
    });
  }
  runtime.safeExecuteScriptFiles = safeExecuteScriptFiles;
  function safeInsertCss(tabId, file) {
    return new Promise((resolve, reject) => {
      chrome.scripting.insertCSS({
        target: {
          tabId,
          allFrames: true
        },
        files: [file]
      }, () => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message || "insertCSS failed";
          if (runtime.isSafeInjectError(message)) {
            resolve();
            return;
          }
          reject(new Error(message));
          return;
        }
        resolve();
      });
    });
  }
  runtime.safeInsertCss = safeInsertCss;
  function isSafeInjectError(message) {
    const text = String(message || "").toLowerCase();
    return text.includes("cannot access contents of") || text.includes("the extensions gallery cannot be scripted") || text.includes("missing host permission");
  }
  runtime.isSafeInjectError = isSafeInjectError;
}
