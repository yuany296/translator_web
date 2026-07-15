export function installPlatformDom(runtime) {
  function computeTargetSubRect(rect, displayRect) {
    const offsetX = Number(displayRect && displayRect.offsetX);
    const offsetY = Number(displayRect && displayRect.offsetY);
    const width = Number(displayRect && displayRect.width);
    const height = Number(displayRect && displayRect.height);
    if (!(Number.isFinite(offsetX) && Number.isFinite(offsetY) && width > 0 && height > 0)) {
      return rect;
    }
    return {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      right: rect.left + offsetX + width,
      bottom: rect.top + offsetY + height,
      width,
      height
    };
  }
  runtime.computeTargetSubRect = computeTargetSubRect;
  function computeBackgroundImageRect(target, rect, imageMeta) {
    const imageWidth = Number(imageMeta && imageMeta.width);
    const imageHeight = Number(imageMeta && imageMeta.height);
    if (!(imageWidth > 0 && imageHeight > 0 && rect.width > 0 && rect.height > 0)) {
      return rect;
    }
    const style = getComputedStyle(target);
    const size = String(style.backgroundSize || "auto").trim().toLowerCase();
    if (size !== "contain") {
      return rect;
    }
    const imageRatio = imageWidth / imageHeight;
    const boxRatio = rect.width / rect.height;
    let width = rect.width;
    let height = rect.height;
    if (boxRatio > imageRatio) {
      height = rect.height;
      width = height * imageRatio;
    } else {
      width = rect.width;
      height = width / imageRatio;
    }
    const offsetX = (rect.width - width) * runtime.parseBackgroundPositionRatio(style.backgroundPositionX);
    const offsetY = (rect.height - height) * runtime.parseBackgroundPositionRatio(style.backgroundPositionY);
    return {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      right: rect.left + offsetX + width,
      bottom: rect.top + offsetY + height,
      width,
      height
    };
  }
  runtime.computeBackgroundImageRect = computeBackgroundImageRect;
  function parseBackgroundPositionRatio(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text === "left" || text === "top") {
      return 0;
    }
    if (text === "right" || text === "bottom") {
      return 1;
    }
    if (text === "center") {
      return 0.5;
    }
    const percent = text.match(/(-?\d+(?:\.\d+)?)%/);
    if (percent) {
      return runtime.clamp(Number(percent[1]) / 100, 0, 1);
    }
    const pixel = text.match(/(-?\d+(?:\.\d+)?)px/);
    if (pixel) {
      return Number(pixel[1]) > 0 ? 1 : 0;
    }
    return 0.5;
  }
  runtime.parseBackgroundPositionRatio = parseBackgroundPositionRatio;
  function clamp(value, min, max) {
    const num = Number(value);
    const safe = Number.isFinite(num) ? num : min;
    return Math.min(max, Math.max(min, safe));
  }
  runtime.clamp = clamp;
  function isDataUrl(value) {
    return /^data:[^;]+;base64,/i.test(String(value || ""));
  }
  runtime.isDataUrl = isDataUrl;
  function isBlobUrl(value) {
    return /^blob:/i.test(String(value || "").trim());
  }
  runtime.isBlobUrl = isBlobUrl;
  function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || "").trim());
  }
  runtime.isHttpUrl = isHttpUrl;
  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, Math.max(0, ms)));
  }
  runtime.sleep = sleep;
  function getErrorMessage(error) {
    if (!error) {
      return "Unknown error";
    }
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
    return String(error);
  }
  runtime.getErrorMessage = getErrorMessage;
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
}
