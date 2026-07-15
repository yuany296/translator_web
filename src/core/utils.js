/* ===================================================================
 * core/utils.js — 跨模块共享工具函数
 *
 * 纯函数，不依赖 chrome.* 或 DOM（storageGet/Set/Remove 除外）。
 * =================================================================== */
(function () {
  "use strict";
  if (globalThis.MtCoreUtils) return;

  // ── 数值 ──

  /** 钳制 value 到 [min, max] 范围 */
  function clamp(value, min, max) {
    const safe = Number.isFinite(value) ? value : min;
    return Math.min(max, Math.max(min, safe));
  }

  /** 将 value 转为安全数字，无效则返回 fallback */
  function toNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  /** Promise 延时（毫秒） */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  /** 四舍五入到指定位数 */
  function roundTo(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round((Number(value) || 0) * factor) / factor;
  }

  // ── 哈希 / 序列化 ──

  /** 稳定 JSON 序列化（key 排序），用于缓存 key 生成 */
  function stableSerialize(value) {
    if (Array.isArray(value)) {
      return `[${value.map(stableSerialize).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  }

  /** FNV-1a 32-bit 哈希，输出 8 位 hex */
  function hashString(input) {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  /** 128-bit 稳定哈希，用于避免大量缓存 key 的碰撞 */
  function stableHash128(input) {
    const text = String(input || "");
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    let h3 = 0x85ebca6b;
    let h4 = 0xc2b2ae35;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ code, 0x5bd1e995);
      h3 = Math.imul(h3 ^ code, 0x27d4eb2d);
      h4 = Math.imul(h4 ^ code, 0x165667b1);
      h2 ^= h1 >>> 13;
      h3 ^= h2 >>> 15;
      h4 ^= h3 >>> 16;
    }
    return [h1, h2, h3, h4]
      .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
      .join("");
  }

  // ── 类型判断 ──

  function isDataUrl(value) {
    return /^data:[^;]+;base64,/i.test(String(value || ""));
  }

  function isBlobUrl(value) {
    return /^blob:/i.test(String(value || ""));
  }

  function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ""));
  }

  /** 从 data URL 提取 MIME 类型 */
  function getDataUrlMimeType(dataUrl) {
    const match = String(dataUrl).match(/^data:([^;]+);base64,/i);
    return match ? String(match[1]).toLowerCase() : "";
  }

  /** 解析 data URL 为 { mediaType, base64Data } */
  function parseDataUrl(dataUrl) {
    const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) {
      throw new Error("Invalid data URL format");
    }
    return {
      mediaType: String(match[1]).toLowerCase(),
      base64Data: match[2]
    };
  }

  // ── 错误处理 ──

  /** 从各种错误类型提取可读信息 */
  function getErrorMessage(error) {
    if (!error) {
      return "Unknown error";
    }
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
    return String(error);
  }

  // ── 文本 ──

  /** NFKC 归一化 + 去空白 */
  function normalizeText(value) {
    const text = String(value ?? "");
    const nfkc = typeof text.normalize === "function" ? text.normalize("NFKC") : text;
    return nfkc.replace(/\s+/gu, " ").trim();
  }

  /** 用于比较的文本：去空白 + 小写 */
  function normalizeComparableText(value) {
    return normalizeText(value).toLocaleLowerCase().replace(/\s+/gu, "");
  }

  // ── 几何 ──

  /** 矩形归一化：确保 x/y/w/h 为有效数字 */
  function normalizeRectLike(rect) {
    if (!rect || typeof rect !== "object") return { x: 0, y: 0, w: 0, h: 0 };
    return {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      w: Number(rect.w || rect.width) || 0,
      h: Number(rect.h || rect.height) || 0
    };
  }

  // ── Chrome 存储（Promise 封装） ──

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result || {});
        }
      });
    });
  }

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

  // ── 导出 ──

  globalThis.MtCoreUtils = Object.freeze({
    clamp, toNumber, sleep, roundTo,
    stableSerialize, hashString, stableHash128,
    isDataUrl, isBlobUrl, isHttpUrl,
    getDataUrlMimeType, parseDataUrl,
    getErrorMessage,
    normalizeText, normalizeComparableText,
    normalizeRectLike,
    storageGet, storageSet, storageRemove
  });
})();
