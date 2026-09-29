import { hashString36 } from "./stable-hash.js";

const DEFAULT_LIBRARY_ID = "default";
const DEFAULT_LIBRARY_NAME = "默认术语库";
const MAX_LIBRARIES = 50;
const MAX_LIBRARY_NAME = 60;
const MAX_LIBRARY_ID = 60;
const MAX_URLS_PER_LIBRARY = 20;

function normalizeLibraryId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, MAX_LIBRARY_ID);
}

function normalizeLibraryName(value, fallback = "未命名术语库") {
  const name = String(value || "").replace(/\s+/gu, " ").trim().slice(0, MAX_LIBRARY_NAME);
  return name || fallback;
}

/**
 * 通配模式：`*.google.com`、`google.com/mail/*`、`https://www.google.com/*`（对齐沉浸式翻译的写法）。
 * 语义：
 *   - 主机 `*.google.com` → 任意子域（不包含 google.com 本身）；主机里其它位置的 `*` 匹配任意字符（不跨 `/`）；
 *   - 路径里带 `*` → 任意字符，**可以跨 `/`**（`google.com/mail/*` 命中 `/mail/a/b`）；
 *   - 路径里不带 `*` → 仍是「按段边界前缀」匹配（绑定总览页照样接住章节页）；
 *   - 只有主机、没写路径（`*.google.com`）→ 该主机下任意页面；
 *   - 不写协议 → http 与 https 都匹配（老写法不带协议的裸域名仍按 https 补全，行为不变）。
 */
function isLibraryUrlPattern(value) {
  return String(value || "").includes("*");
}

/** 通配模式规范化：主机小写、去查询串/片段/末尾斜杠，保留 `*` 与有没有写协议。 */
function normalizeLibraryUrlPattern(compact) {
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(compact);
  const scheme = schemeMatch ? `${schemeMatch[1].toLowerCase()}://` : "";
  if (scheme && scheme !== "http://" && scheme !== "https://") {
    return "";
  }
  const rest = schemeMatch ? compact.slice(schemeMatch[0].length) : compact;
  const slash = rest.indexOf("/");
  const host = (slash >= 0 ? rest.slice(0, slash) : rest).toLowerCase();
  const path = slash >= 0 ? rest.slice(slash).replace(/\/+$/u, "") : "";
  if (!host || !/^[a-z0-9.*\-]+(?::\d+)?$/u.test(host)) {
    return "";
  }
  return `${scheme}${host}${path}`;
}

/**
 * 绑定网址统一成 `协议//主机/路径`：去掉查询串与片段、去掉末尾斜杠、主机小写。
 * 裸域名（缺少协议）按 https 补全，便于用户直接粘贴 `page.kakao.com/content/1`；
 * 其他写法（含非法协议或不含点号的自由文本）一律丢弃。带 `*` 的按通配模式走。
 */
function normalizeLibraryUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const compact = raw.replace(/[#?].*$/u, "").trim();
  if (!compact) {
    return "";
  }
  if (isLibraryUrlPattern(compact)) {
    return normalizeLibraryUrlPattern(compact);
  }
  const direct = parseLibraryUrl(compact);
  if (direct) {
    return direct;
  }
  if (compact.includes("://")) {
    return "";
  }
  const host = compact.split("/")[0];
  return /^[\w-]+(?:\.[\w-]+)+(?::\d+)?$/u.test(host) ? parseLibraryUrl(`https://${compact}`) : "";
}

function parseLibraryUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    const path = url.pathname.replace(/\/+$/u, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return "";
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[-[\]{}()*+?.,\\^$|#\s]/gu, "\\$&");
}

/** 通配模式 → 正则（语义见文件顶部通配说明）。 */
function libraryUrlPatternRegex(pattern) {
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(pattern);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "";
  const rest = schemeMatch ? pattern.slice(schemeMatch[0].length) : pattern;
  const slash = rest.indexOf("/");
  const host = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash) : "";
  const schemePart = scheme ? `${scheme}:` : "(?:https?):";
  let hostPart;
  if (host === "*") {
    hostPart = "[^/]+";
  } else if (host.startsWith("*.")) {
    hostPart = `[^/]*?\\.${escapeRegExp(host.slice(2))}`;
  } else {
    hostPart = escapeRegExp(host).replace(/\\\*/gu, "[^/]*");
  }
  let pathPart;
  if (!path) {
    pathPart = "(?:/.*)?";
  } else if (path.includes("*")) {
    if (/\/\*$/u.test(path)) {
      // 结尾的 `/*`：该目录及其下任意层级。写成 `(?:/.*)?` 才能连「没有那个斜杠」的地址一起接住
      // （页面地址规范化时末尾斜杠会被去掉，`google.com/mail/*` 必须也能命中 `google.com/mail`）。
      pathPart = `${escapeRegExp(path.slice(0, -2))}(?:/.*)?`;
    } else {
      pathPart = `${escapeRegExp(path).replace(/\\\*/gu, ".*?")}/?`;
    }
  } else {
    // 不带 `*` 的路径仍是「按段边界前缀」：后面要么没了，要么从 `/` 接着往下走。
    pathPart = `${escapeRegExp(path)}(?:/.*)?`;
  }
  return new RegExp(`^${schemePart}//${hostPart}${pathPart}$`, "u");
}

/**
 * 绑定网址是否命中这条页面地址。
 * 老写法（不带 `*`）仍是「同协议 + 同主机 + 按段边界的路径前缀」；带 `*` 的走通配。
 */
function libraryUrlMatches(pageUrl, pattern) {
  const page = normalizeLibraryUrl(pageUrl);
  const rawPattern = String(pattern || "").trim();
  if (!page || !rawPattern) {
    return false;
  }
  if (isLibraryUrlPattern(rawPattern)) {
    const normalized = normalizeLibraryUrlPattern(rawPattern.replace(/[#?].*$/u, "").trim());
    return normalized ? libraryUrlPatternRegex(normalized).test(page) : false;
  }
  const target = normalizeLibraryUrl(rawPattern);
  if (!target) {
    return false;
  }
  if (page === target) {
    return true;
  }
  return page.startsWith(target) && page.charAt(target.length) === "/";
}

function normalizeLibrary(value, index = 0) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const name = normalizeLibraryName(value.name, `术语库 ${index + 1}`);
  const urls = [];
  for (const item of Array.isArray(value.urls) ? value.urls : []) {
    const url = normalizeLibraryUrl(item);
    if (url && !urls.includes(url)) {
      urls.push(url);
    }
    if (urls.length >= MAX_URLS_PER_LIBRARY) {
      break;
    }
  }
  const applyUrls = [];
  for (const item of Array.isArray(value.applyUrls) ? value.applyUrls : []) {
    const url = normalizeLibraryUrl(item);
    if (url && !applyUrls.includes(url)) {
      applyUrls.push(url);
    }
    if (applyUrls.length >= MAX_URLS_PER_LIBRARY) {
      break;
    }
  }
  return {
    id: normalizeLibraryId(value.id) || `library-${hashString(name)}`,
    name,
    enabled: value.enabled !== false,
    urls,
    applyUrls,
    createdAt: Math.max(0, Math.floor(Number(value.createdAt) || 0)),
    updatedAt: Math.max(0, Math.floor(Number(value.updatedAt) || 0))
  };
}

function createDefaultLibrary(now = 0) {
  return {
    id: DEFAULT_LIBRARY_ID, name: DEFAULT_LIBRARY_NAME, enabled: true, urls: [], applyUrls: [],
    createdAt: now, updatedAt: now
  };
}

/** 应用网址是否命中当前页面。applyUrls 为空表示全站生效。 */
function libraryApplyUrlMatches(pageUrl, applyUrls) {
  const patterns = Array.isArray(applyUrls) ? applyUrls : [];
  if (patterns.length === 0) {
    return true;
  }
  if (!pageUrl) {
    return false;
  }
  return patterns.some(pattern => libraryUrlMatches(pageUrl, pattern));
}

/** 归一化库列表：按 id 去重、限量，并保证默认库始终存在（缺失时放在最前）。 */
function normalizeLibraries(value) {
  const raw = Array.isArray(value) ? value : [];
  const libraries = [];
  const seen = new Set();
  for (let index = 0; index < raw.length && libraries.length < MAX_LIBRARIES; index += 1) {
    const library = normalizeLibrary(raw[index], index);
    if (!library || seen.has(library.id)) {
      continue;
    }
    seen.add(library.id);
    libraries.push(library);
  }
  if (!seen.has(DEFAULT_LIBRARY_ID)) {
    libraries.unshift(createDefaultLibrary());
  }
  return libraries.slice(0, MAX_LIBRARIES);
}

function getLibrary(value, libraryId) {
  const libraries = Array.isArray(value) ? value : [];
  const id = normalizeLibraryId(libraryId);
  return libraries.find(library => library.id === id)
    || libraries.find(library => library.id === DEFAULT_LIBRARY_ID)
    || null;
}

function getLibraryName(value, libraryId) {
  const library = getLibrary(value, libraryId);
  return library ? library.name : "";
}

function isLibraryEnabled(value, libraryId) {
  const library = getLibrary(value, libraryId);
  return Boolean(library) && library.enabled !== false;
}

/** 更「具体」的绑定赢：比字面量长度（`*` 不算），所以 `.../content/1` 压过 `.../*`。 */
function patternSpecificity(pattern) {
  return String(pattern || "").replace(/\*/gu, "").length;
}

/**
 * 按网址选库：只考虑已启用的库，取最具体的那条绑定，同样具体时取列表靠前者。
 * 返回 `{ libraryId, pattern }`；没有任何库匹配时返回 null。
 */
function matchLibraryByUrl(libraries, pageUrl) {
  const page = normalizeLibraryUrl(pageUrl);
  if (!page) {
    return null;
  }
  let best = null;
  for (const library of Array.isArray(libraries) ? libraries : []) {
    if (!library || library.enabled === false) {
      continue;
    }
    for (const item of Array.isArray(library.urls) ? library.urls : []) {
      if (!libraryUrlMatches(page, item)) {
        continue;
      }
      const pattern = normalizeLibraryUrl(item);
      const specificity = patternSpecificity(pattern);
      if (!best || specificity > best.specificity) {
        best = { libraryId: library.id, pattern, specificity };
      }
    }
  }
  return best ? { libraryId: best.libraryId, pattern: best.pattern } : null;
}

function hashString(value) {
  return hashString36(value);
}

export default Object.freeze({
  DEFAULT_LIBRARY_ID,
  DEFAULT_LIBRARY_NAME,
  MAX_LIBRARIES,
  MAX_LIBRARY_NAME,
  MAX_LIBRARY_ID,
  MAX_URLS_PER_LIBRARY,
  normalizeLibraryId,
  normalizeLibraryName,
  normalizeLibraryUrl,
  isLibraryUrlPattern,
  libraryUrlMatches,
  libraryUrlPatternRegex,
  libraryApplyUrlMatches,
  patternSpecificity,
  normalizeLibrary,
  normalizeLibraries,
  createDefaultLibrary,
  getLibrary,
  getLibraryName,
  isLibraryEnabled,
  matchLibraryByUrl,
  hashString
});
