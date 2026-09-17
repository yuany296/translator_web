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
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
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
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
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
  return [h1, h2, h3, h4].map(part => (part >>> 0).toString(16).padStart(8, "0")).join("");
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

/**
 * LLM 翻译时常把对话引号当作"可省略的格式"丢掉(尤其 JSON 模式与流式 NDJSON),
 * 而流水线里没有任何环节会主动删引号。此函数做确定性兜底:若原文整段被某一对
 * 引号包住,且译文里一个引号字符都没有,就把同一对引号加回译文。
 * 已有引号(任意风格)的译文保持原样,避免双重包裹。
 *
 * 顺序有意义:第一个「首字符+尾字符」都命中的对子胜出,所以更罕见的写法放前面。
 * 单引号必须排在双引号之前判断——ASCII 的 ' 与 " 会互相干扰时以成对语义为准。
 */
const DIALOGUE_QUOTE_PAIRS = Object.freeze([
  ["\u201c", "\u201d"], // “ ”
  ["\u201e", "\u201c"], // „ “(德语式低开高收)
  ["\u2018", "\u2019"], // ‘ ’
  ["\u201a", "\u2018"], // ‚ ‘
  ["\u300c", "\u300d"], // 「 」
  ["\u300e", "\u300f"], // 『 』
  ["\uff62", "\uff63"], // ｢ ｣(半角角括号,日式 EPUB 常见)
  ["\u00ab", "\u00bb"], // « »
  ["\u2039", "\u203a"], // ‹ ›
  ["\"", "\""],
  ["\uff02", "\uff02"], // ＂
  ["'", "'"],
  ["\u2019", "\u2019"], // ’ ’(模型偶尔两边都用收尾单引号)
  ["\uff07", "\uff07"] // ＇
]);

/** 所有可能出现在对话引号位置的字符(检测用)。 */
const DIALOGUE_QUOTE_CHARS = Object.freeze([...new Set(DIALOGUE_QUOTE_PAIRS.flat())]);

/** 文本里是否出现任意对话引号字符。 */
export function containsDialogueQuote(text) {
  const value = String(text || "");
  return DIALOGUE_QUOTE_CHARS.some(char => value.includes(char));
}

export function restoreDialogueQuotes(originalText, translatedText) {
  const source = String(originalText || "").trim();
  const translated = String(translatedText || "");
  if (!source || !translated.trim()) return translated;
  // 译文里只要出现任意引号字符就认为引号语义仍在,不再包裹。
  if (containsDialogueQuote(translated)) return translated;
  for (const [open, close] of DIALOGUE_QUOTE_PAIRS) {
    if (source.length >= 2 && source.startsWith(open) && source.endsWith(close)) {
      return `${open}${translated.trim()}${close}`;
    }
  }
  return translated;
}

/**
 * 原文有引号、译文却一个都没有,且整段包裹也修不回来(原文不是整段被引号包住,
 * 例如 `"어쩌고" 그가 말했다.`)——这种只有模型能修,交给校验层报错重试。
 */
export function hasDroppedDialogueQuotes(originalText, translatedText) {
  return containsDialogueQuote(originalText) && !containsDialogueQuote(translatedText);
}

// ── 几何 ──

/** 矩形归一化：确保 x/y/w/h 为有效数字 */
function normalizeRectLike(rect) {
  if (!rect || typeof rect !== "object") return {
    x: 0,
    y: 0,
    w: 0,
    h: 0
  };
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
    chrome.storage.local.get(keys, result => {
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
export default Object.freeze({
  clamp,
  toNumber,
  sleep,
  roundTo,
  stableSerialize,
  hashString,
  stableHash128,
  isDataUrl,
  isBlobUrl,
  isHttpUrl,
  getDataUrlMimeType,
  parseDataUrl,
  getErrorMessage,
  normalizeText,
  normalizeComparableText,
  DIALOGUE_QUOTE_PAIRS,
  DIALOGUE_QUOTE_CHARS,
  containsDialogueQuote,
  restoreDialogueQuotes,
  hasDroppedDialogueQuotes,
  normalizeRectLike,
  storageGet,
  storageSet,
  storageRemove
});
