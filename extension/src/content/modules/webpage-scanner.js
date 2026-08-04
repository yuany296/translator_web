/**
 * Webpage text-node scanning for the webpage translation action.
 *
 * Scanning rules live in pure predicates (unit-testable in Node); the DOM
 * collection walks the light DOM only (plugin UI and shadow roots excluded),
 * never rewrites innerHTML, and returns stable per-node ids so translations
 * can be aligned by id and restored node-by-node.
 */
import cacheCore from "../../shared/translation-cache.js";

// BUTTON is intentionally NOT excluded: ordinary text buttons (登录/提交/下一页)
// carry meaningful text. Icon-only buttons yield no eligible text nodes, so they
// are skipped naturally by the eligibility rules; input[type=button] values are
// attributes, not text nodes, and are never touched.
const EXCLUDED_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "INPUT",
  "SELECT", "OPTION", "TITLE", "META", "LINK", "IFRAME", "SVG"
]);

const MAX_SCAN_NODES = 1500;

function normalizeCandidateText(value) {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t ]+/gu, " ")
    .trim();
}

function hasNaturalLanguageMeaning(text) {
  return !/^[\s\p{P}\p{S}]+$/u.test(text);
}

function looksLikeUrl(text) {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ||
    /^(?:www\.|mailto:|tel:)/iu.test(text) ||
    /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/u.test(text);
}

function looksLikePath(text) {
  return /^[a-zA-Z]:[\\/]/u.test(text) ||
    /^[./]{1,2}[\\/]/u.test(text) ||
    /^\/[^/]*(?:[\\/][^/]*)+$/u.test(text);
}

function looksLikeCode(text) {
  if (/[{}]/.test(text) && /[;=]/.test(text)) return true;
  if (/^[\s]*(?:function|const|let|var|class|import|export|return|console\.)\b/u.test(text)) return true;
  if (/[`~]/.test(text) && /\b(?:var|if|for|while|return)\b/u.test(text)) return true;
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text);
}

// Conservative Simplified-Chinese detection. Only text that is clearly
// simplified-Chinese-dominant is skipped: it must contain Han characters, no
// Hangul, no Kana, no traditional-only characters, and at least one
// simplified-only marker. 韩文夹汉字 / 日文汉字+假名 / 繁体中文 / 含拉丁字母的
// 混合文本都不会因为"出现了汉字"而被误跳过。
const SIMPLIFIED_MARKERS = "这们个吗还从没见问说听读写干办东买车卖师医电书门开国时间岁点钟号机网页视发边对请让进过长头里关现儿么";
const TRADITIONAL_MARKERS = "們這個嗎還從沒見問說聽讀寫幹辦東買車賣師醫電書門開國時間歲點鐘號機網頁視發邊對請讓進過長頭裏裡關現兒麼與並來戶後無聽";

function looksSimplifiedChinese(text) {
  if (!/[一-鿿]/u.test(text)) return false;
  if (/[가-힯぀-ヿ]/u.test(text)) return false;
  if (/[a-zA-Z]/u.test(text) && !/[一-鿿]{4,}/u.test(text)) return false;
  if ([...TRADITIONAL_MARKERS].some(char => text.includes(char))) return false;
  return [...SIMPLIFIED_MARKERS].some(char => text.includes(char));
}

function isEligibleWebpageText(text, info = {}) {
  const normalized = normalizeCandidateText(text);
  if (!normalized) return false;
  if (info.hidden === true || info.editable === true || info.inExtensionUi === true) return false;
  if (!hasNaturalLanguageMeaning(normalized)) return false;
  if (looksLikeUrl(normalized)) return false;
  if (looksLikePath(normalized)) return false;
  if (looksLikeCode(normalized)) return false;
  if (looksSimplifiedChinese(normalized)) return false;
  return true;
}

function isElementHidden(node) {
  try {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return true;
  } catch {
    // keep the node when computed style is unavailable
  }
  if (node.offsetParent === null && node.getBoundingClientRect().width === 0) return true;
  return false;
}

function collectWebpageTextNodes(options = {}) {
  if (typeof document === "undefined" || typeof document.createTreeWalker !== "function") return [];
  const root = document.body || document.documentElement;
  if (!root) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const entries = [];
  const seen = new Set();
  let node = walker.nextNode();
  while (node && entries.length < MAX_SCAN_NODES) {
    const parent = node.parentElement;
    if (parent && !seen.has(parent)) {
      seen.add(parent);
      const tag = String(parent.tagName || "");
      if (EXCLUDED_TAGS.has(tag) || parent.closest("[data-manga-translator-overlay]") ||
        parent.closest("[data-manga-translator-novel]") || parent.isContentEditable ||
        parent.closest("[contenteditable]")) {
        node = walker.nextNode();
        continue;
      }
    }
    const info = {
      hidden: options.checkHidden === false ? false : isElementHidden(parent),
      editable: false,
      inExtensionUi: false
    };
    if (isEligibleWebpageText(node.nodeValue, info)) {
      const text = normalizeCandidateText(node.nodeValue);
      entries.push({ node, text, id: `web-${entries.length}`, index: entries.length });
    }
    node = walker.nextNode();
  }
  return entries;
}

function isPluginTextNode(node) {
  return !!node?.parentElement?.closest?.("[data-manga-translator-overlay]");
}

/**
 * Nearest semantic container signature for cache identity. Walks up at most
 * 5 levels; the first element carrying a stable identity (role / id /
 * aria-label / name / href) becomes the signature. Without any stable
 * identity the parent + grandparent tag chain is used, so plain wrappers
 * still distinguish "Open" in a nav item from "Open" in a dialog button.
 */
function buildWebpageContainerSignature(node, env = null) {
  let element = node;
  if (element && element.nodeType !== 1) element = element.parentElement;
  let depth = 0;
  while (element && depth < 5) {
    const parts = [String(element.tagName || "").toLowerCase()];
    const get = typeof element.getAttribute === "function" ? element.getAttribute.bind(element) : () => null;
    const role = get("role");
    if (role) parts.push(`role:${role}`);
    if (element.id) parts.push(`id:${element.id}`);
    const ariaLabel = get("aria-label");
    if (ariaLabel) parts.push(`aria:${ariaLabel}`);
    if (element.name) parts.push(`name:${element.name}`);
    if (element.href) parts.push(`href:${element.href}`);
    if (parts.length > 1) return cacheCore.stableId(parts);
    element = element.parentElement;
    depth += 1;
  }
  const parent = node && node.parentElement;
  const grand = parent && parent.parentElement;
  return cacheCore.stableId([parent && parent.tagName, grand && grand.tagName, "plain"]);
}

/**
 * Adjacent text of a text node (up to 3 siblings per side) for the context
 * fingerprint used by translationKey.
 */
function buildWebpageNeighborContext(node) {
  let previousText = "";
  let nextText = "";
  let sibling = node && node.previousSibling;
  let walked = 0;
  while (sibling && walked < 3 && !previousText) {
    if (sibling.nodeType === 3 && String(sibling.nodeValue || "").trim()) {
      previousText = String(sibling.nodeValue || "");
    }
    sibling = sibling.previousSibling;
    walked += 1;
  }
  sibling = node && node.nextSibling;
  walked = 0;
  while (sibling && walked < 3 && !nextText) {
    if (sibling.nodeType === 3 && String(sibling.nodeValue || "").trim()) {
      nextText = String(sibling.nodeValue || "");
    }
    sibling = sibling.nextSibling;
    walked += 1;
  }
  return { previousText, nextText };
}

function shouldSkipElement(parent) {
  const tag = String(parent.tagName || "");
  return EXCLUDED_TAGS.has(tag) || parent.closest("[data-manga-translator-overlay]") ||
    parent.closest("[data-manga-translator-novel]") || parent.isContentEditable ||
    parent.closest("[contenteditable]");
}

function createWebpageScanWalker(doc = null) {
  if (doc == null) {
    if (typeof document === "undefined" || typeof document.createTreeWalker !== "function") return null;
    doc = document;
  }
  const root = doc.body || doc.documentElement;
  if (!root) return null;
  return doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, null);
}

/**
 * Consume the next chunk of eligible text nodes from an existing walker.
 * The background scan processes the document in chunks of up to maxNodes or
 * timeBudgetMs, enqueueing each chunk as it completes instead of waiting for
 * the whole page scan.
 */
function takeNextWebpageTextChunk(walker, options = {}) {
  const maxNodes = Math.max(1, Number(options.maxNodes) || 200);
  const timeBudgetMs = Math.max(0, Number(options.timeBudgetMs) || 8);
  const checkHidden = options.checkHidden !== false;
  const out = [];
  const seen = new Set();
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const hasTime = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt < timeBudgetMs;
  while (out.length < maxNodes && hasTime()) {
    let node = walker && typeof walker.nextNode === "function" ? walker.nextNode() : null;
    if (!node) return { done: true, entries: out };
    const parent = node.parentElement;
    if (parent && !seen.has(parent)) {
      seen.add(parent);
      if (shouldSkipElement(parent)) continue;
    }
    const info = { hidden: checkHidden && isElementHidden(parent), editable: false, inExtensionUi: false };
    if (isEligibleWebpageText(node.nodeValue, info)) {
      out.push({ node, text: normalizeCandidateText(node.nodeValue), index: out.length });
    }
  }
  return { done: false, entries: out };
}

export default Object.freeze({
  EXCLUDED_TAGS,
  MAX_SCAN_NODES,
  normalizeCandidateText,
  isEligibleWebpageText,
  collectWebpageTextNodes,
  isPluginTextNode,
  buildWebpageContainerSignature,
  buildWebpageNeighborContext,
  createWebpageScanWalker,
  takeNextWebpageTextChunk
});
