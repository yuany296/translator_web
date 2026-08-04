/**
 * Shared translation-cache contracts and utilities.
 *
 * Modes:
 *   - "novel": Kakao novel paragraphs, keyed by series+chapter+paragraph source hash.
 *   - "comic": OCR block translations, keyed by image/block source hash.
 *   - "webpage": DOM text-node translations, keyed by normalized URL + source hash.
 *
 * Version priority (highest first):
 *   1. user manually edited
 *   2. user explicitly pinned AI version
 *   3. latest AI auto-translation
 *   4. older cached versions
 */

const MODES = Object.freeze(["novel", "comic", "webpage"]);
const SOURCES = Object.freeze(["api", "manual"]);
const DB_NAME = "MangaTranslatorTranslationCache";
const DB_VERSION = 3;
const STORE_NAME = "translationCache";
const LEGACY_STORE_NAME = "translations";
const PENDING_STORE_NAME = "pendingOperations";
const SYNC_STORE_NAME = "syncMetadata";

function normalizeSourceText(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u200b-\u200d\ufeff]/gu, "")
    .replace(/[ \t ]+/gu, " ")
    .trim();
}

function computeSourceHash(normalized) {
  let hash = 0x811c9dc5;
  const text = String(normalized || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableId(parts) {
  return computeSourceHash(parts.filter(Boolean).join("\u0000"));
}

/**
 * Normalized page key for webpage translations: fragment stripped, tracking
 * parameters (utm_*, gclid, fbclid, …) dropped, remaining query parameters
 * sorted for stability. Parameters that may decide page content stay; pure
 * tracking parameters never change content. Kakao "/" and "/menu/10010/" are
 * different pages because their paths differ.
 */
const TRACKING_PARAM_RE = /^(?:utm_|gclid|fbclid|mc_cid|mc_eid|igshid|_ga|_gl|ref_src|ref_url|yclid|msclkid)/iu;

function normalizePageKey(url) {
  try {
    const parsed = new URL(String(url || ""), "https://placeholder.invalid");
    parsed.hash = "";
    const pairs = [...new URLSearchParams(parsed.search).entries()]
      .filter(([key]) => !TRACKING_PARAM_RE.test(key))
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1)));
    parsed.search = pairs.length ? pairs.map(([key, value]) => `${key}=${value}`).join("&") : "";
    return parsed.href;
  } catch {
    return String(url || "").split("#")[0];
  }
}

/**
 * Binding identity of one webpage text node: pageKey + source hash + nearest
 * semantic container signature + local index inside that container. Stable
 * across re-scans and partial viewport scans — unlike a global occurrence
 * index, which shifts whenever the scan order changes.
 */
function buildBindingKey({ pageKey, sourceHash, containerSignature = "", localIndex = 0 }) {
  return stableId([pageKey, sourceHash, containerSignature, localIndex]);
}

/**
 * Translation identity for cross-page reuse: normalized source + resolved
 * source language + target language + context fingerprint. The context
 * fingerprint (nearest container signature + adjacent text) keeps short
 * strings like "Open" from being mis-reused across different UI contexts.
 */
function buildTranslationKey({ normalized, sourceLanguage = "auto", targetLanguage = "zh-CN", contextFingerprint = "" }) {
  return stableId([normalized, sourceLanguage, targetLanguage, contextFingerprint]);
}

/**
 * Record id for the v3 binding-key identity. Exact bindingKey lookup takes
 * precedence; translationKey lookup is the cross-page reuse fallback.
 */
function buildWebpageRecordIdFromBinding({ bindingKey, sourceHash, sourceLanguage = "auto", targetLanguage = "zh-CN" }) {
  return stableId(["webpage", bindingKey, sourceHash, `${sourceLanguage}>${targetLanguage}`]);
}

/**
 * Stable fingerprint of the translation configuration. Field order is fixed,
 * missing fields get explicit defaults, and no secret (API key, request
 * headers) may ever be part of it. Records saved with an older fingerprint
 * (or without one) still work: classifyCacheMatch reports them as
 * "stale-config" instead of dropping them.
 */
function buildTranslationConfigFingerprint(config = {}) {
  const descriptor = {
    provider: String(config.provider || "default"),
    model: String(config.model || "default"),
    sourceLanguage: String(config.sourceLanguage || "auto"),
    targetLanguage: String(config.targetLanguage || "zh-CN"),
    promptVersion: String(config.promptVersion || ""),
    glossaryVersion: String(config.glossaryVersion || ""),
    stylePreset: String(config.stylePreset || "")
  };
  return stableId([
    descriptor.provider,
    descriptor.model,
    descriptor.sourceLanguage,
    descriptor.targetLanguage,
    descriptor.promptVersion,
    descriptor.glossaryVersion,
    descriptor.stylePreset
  ]);
}

/**
 * Reserved for context-sensitive webpage caching (same short UI text may
 * repeat on one page). Returns undefined when no context is available, so
 * callers keep sharing translations for ordinary short UI strings.
 */
function buildContextFingerprint(context = {}) {
  const previousText = String(context.previousText || "").trim();
  const nextText = String(context.nextText || "").trim();
  const semanticRegion = String(context.semanticRegion || "").trim();
  if (!previousText && !nextText && !semanticRegion) return undefined;
  return stableId([previousText.slice(-120), nextText.slice(0, 120), semanticRegion]);
}

function classifyCacheMatch(record, fingerprint = "") {
  if (!record || !String(record.translatedText || "").trim()) return "missing";
  // 分类基于当前实际使用的版本，而不是记录顶层字段
  const active = pickActiveVersion(record);
  if (active && active.source === "manual") return "exact";
  // 优先活动版本指纹；旧记录只有记录级指纹时回退
  const versionFingerprint = String((active && active.translationConfigFingerprint) || record.translationConfigFingerprint || "");
  if (!fingerprint) return "exact";
  if (!versionFingerprint) return "stale-config";
  return versionFingerprint === fingerprint ? "exact" : "stale-config";
}

function createRecordId({
  mode, sourceHash, workId, chapterId, pageKey, blockId, paragraphKey, segmentKey,
  sourceLanguage = "auto", targetLanguage = "zh-CN"
}) {
  const pair = `${sourceLanguage}>${targetLanguage}`;
  if (mode === "novel") {
    return stableId([mode, workId, chapterId, paragraphKey, sourceHash, pair]);
  }
  if (mode === "comic") {
    return stableId([mode, workId, chapterId, pageKey, blockId, sourceHash, pair]);
  }
  return stableId([mode, pageKey, segmentKey, sourceHash, pair]);
}

function buildNovelRecordId(workId, chapterId, sourceHash, paragraphKey = "", sourceLanguage = "auto", targetLanguage = "zh-CN") {
  return createRecordId({ mode: "novel", workId, chapterId, sourceHash, paragraphKey, sourceLanguage, targetLanguage });
}

function buildWebpageRecordId(pageKey, segmentKey, sourceHash, sourceLanguage = "auto", targetLanguage = "zh-CN") {
  return createRecordId({ mode: "webpage", pageKey, segmentKey, sourceHash, sourceLanguage, targetLanguage });
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") return null;
  const mode = String(record.mode || "");
  if (!MODES.includes(mode)) return null;
  const versions = Array.isArray(record.versions) ? record.versions
    .filter(v => v && typeof v === "object" && typeof v.translatedText === "string")
    .map(v => ({
      id: String(v.id || v.versionId || ""),
      translatedText: v.translatedText,
      source: SOURCES.includes(String(v.source)) ? String(v.source) : "api",
      createdAt: Math.max(0, Number(v.createdAt) || 0),
      pinned: v.pinned === true,
      manual: v.manual === true,
      // 每个 AI 版本保存生成时的配置指纹；手动版可为空
      translationConfigFingerprint: String(v.translationConfigFingerprint || "")
    })) : [];
  if (!versions.length) return null;
  const base = {
    id: String(record.id || ""),
    mode,
    sourceText: String(record.sourceText || ""),
    normalizedSourceText: String(record.normalizedSourceText || ""),
    sourceHash: String(record.sourceHash || ""),
    rawSourceHash: String(record.rawSourceHash || record.sourceHash || ""),
    normalizedSourceHash: String(record.normalizedSourceHash || record.sourceHash || ""),
    configuredSourceLanguage: String(record.configuredSourceLanguage || record.sourceLanguage || "auto"),
    resolvedSourceLanguage: String(record.resolvedSourceLanguage || record.sourceLanguage || "auto"),
    targetLanguage: String(record.targetLanguage || "zh-CN"),
    translatedText: String(record.translatedText || ""),
    translationSource: SOURCES.includes(String(record.translationSource)) ? String(record.translationSource) : "api",
    translationConfigFingerprint: String(record.translationConfigFingerprint || ""),
    versions,
    createdAt: Math.max(0, Number(record.createdAt) || 0),
    updatedAt: Math.max(0, Number(record.updatedAt) || 0)
  };
  base.recordId = String(record.recordId || "");
  base.recordKey = String(record.recordKey || record.id || "");
  base.activeVersionId = String(record.activeVersionId || "");
  base.recordRevision = Math.max(0, Number(record.recordRevision) || 0);
  base.changeSeq = Math.max(0, Number(record.changeSeq) || 0);
  base.status = String(record.status || "current");
  if (mode === "novel") {
    base.workId = String(record.workId || "");
    base.chapterId = String(record.chapterId || "");
    base.paragraphIndex = Number.isFinite(Number(record.paragraphIndex)) ? Number(record.paragraphIndex) : undefined;
    base.paragraphKey = String(record.paragraphKey || "");
    base.domAnchor = String(record.domAnchor || "");
  } else if (mode === "webpage") {
    base.normalizedUrl = String(record.normalizedUrl || "");
    base.pageKey = String(record.pageKey || "");
    base.selectorHint = String(record.selectorHint || "");
    base.textIndex = Number.isFinite(Number(record.textIndex)) ? Number(record.textIndex) : undefined;
    base.contextFingerprint = String(record.contextFingerprint || "");
    base.segmentKey = String(record.segmentKey || "");
    base.bindingKey = String(record.bindingKey || "");
    base.translationKey = String(record.translationKey || "");
    base.containerSignature = String(record.containerSignature || "");
    base.domAnchor = String(record.domAnchor || record.selectorHint || "");
  } else if (mode === "comic") {
    base.workId = record.workId != null ? String(record.workId) : undefined;
    base.chapterId = record.chapterId != null ? String(record.chapterId) : undefined;
    base.pageIndex = Number.isFinite(Number(record.pageIndex)) ? Number(record.pageIndex) : undefined;
    base.imageHash = String(record.imageHash || "");
    base.blockId = String(record.blockId || "");
    base.polygon = Array.isArray(record.polygon) ? record.polygon : undefined;
    base.ocrText = String(record.ocrText || "");
    base.style = record.style && typeof record.style === "object" ? record.style : undefined;
  }
  return base;
}

function pickActiveVersion(record) {
  if (!record || !Array.isArray(record.versions)) return null;
  const selected = record.activeVersionId
    ? record.versions.find(version => String(version.id || version.versionId) === String(record.activeVersionId))
    : null;
  if (selected) return selected;
  const manual = record.versions.find(v => v.manual);
  if (manual) return manual;
  const pinned = record.versions.find(v => v.pinned);
  if (pinned) return pinned;
  return record.versions.reduce((best, current) => {
    if (!best || current.createdAt > best.createdAt) return current;
    return best;
  }, null);
}

function buildRecordFromVersions(mode, base, versionsInput) {
  const versions = Array.isArray(versionsInput) ? versionsInput : [];
  const active = pickActiveVersion({ versions });
  if (!active) return null;
  const now = Date.now();
  return normalizeRecord({
    ...base,
    mode,
    translatedText: active.translatedText,
    translationSource: active.source,
    // 顶层指纹跟随当前活动版本；base 中的指纹作为回退
    translationConfigFingerprint: String(active.translationConfigFingerprint || base.translationConfigFingerprint || ""),
    versions,
    createdAt: base.createdAt || now,
    updatedAt: now
  });
}

export default Object.freeze({
  MODES,
  SOURCES,
  DB_NAME,
  DB_VERSION,
  STORE_NAME,
  LEGACY_STORE_NAME,
  PENDING_STORE_NAME,
  SYNC_STORE_NAME,
  normalizeSourceText,
  computeSourceHash,
  stableId,
  createRecordId,
  buildNovelRecordId,
  buildWebpageRecordId,
  normalizePageKey,
  buildBindingKey,
  buildTranslationKey,
  buildWebpageRecordIdFromBinding,
  normalizeRecord,
  pickActiveVersion,
  buildRecordFromVersions,
  buildTranslationConfigFingerprint,
  buildContextFingerprint,
  classifyCacheMatch
});
