import {
  normalizeSentenceExtractionConfig, normalizeTermExtractionConfig, normalizeTranslationConfig
} from "./schema.js";
import llmProviders from "../shared/llm-providers.js";

/**
 * LLM 服务配置库（仿 Android 客户端:选服务商 → 填 API Key/Model → 命名 → 保存）。
 * 每套命名配置 = { provider, baseUrl, model, apiKey },一条配置同时被
 * 翻译服务、整章术语提取、句子级术语提取选用；active 是翻译服务当前用的那一条。
 * 纯函数模块,不直接接触 chrome.storage,便于单测。
 */
export const VENDORS_KEY = "mt_translation_vendors_v1";

/** 提取小节 → 迁移时的命名后缀（配置库按名称索引,名称要能一眼看出用途）。 */
export const EXTRACTION_SECTIONS = Object.freeze({
  termExtraction: "术语提取",
  sentenceExtraction: "句子提取"
});

/** 两个提取小节各自的归一化函数（迁移时要按小节走对应 schema）。 */
const SECTION_NORMALIZERS = Object.freeze({
  termExtraction: normalizeTermExtractionConfig,
  sentenceExtraction: normalizeSentenceExtractionConfig
});

export const DEFAULT_VENDOR_NAME = "默认配置";

/** 校验/提取服务商条目:只保留服务商相关字段,并走与正式配置一致的归一化 */
export function normalizeVendorEntry(value) {
  const normalized = normalizeTranslationConfig(value);
  return {
    provider: normalized.provider,
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    apiKey: normalized.apiKey
  };
}

/** 校验/修复服务商配置状态;无效条目与失效指针自动剔除 */
export function normalizeVendorsState(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const vendors = {};
  const source = value.vendors && typeof value.vendors === "object" ? value.vendors : {};
  for (const [name, entry] of Object.entries(source)) {
    const key = String(name).trim();
    if (key && entry && typeof entry === "object") vendors[key] = normalizeVendorEntry(entry);
  }
  const active = value.active && vendors[String(value.active).trim()] ? String(value.active).trim() : "";
  // baseline:首次保存命名配置前的翻译配置备份,删除全部条目后恢复,避免覆盖用户原配置
  const baseline = value.baseline && typeof value.baseline === "object"
    ? normalizeVendorEntry(value.baseline)
    : null;
  return { vendors, active, baseline };
}

/** 把命名配置套用到翻译配置上:只覆盖服务商字段,语言等其余字段保留。
 * 条目对其自身服务商的槽位有最终决定权——否则同服务商的旧槽位会一直压过
 * 新填的密钥/地址/模型,导致「改了配置不生效」。 */
export function applyVendorEntry(translation, entry) {
  const current = translation && typeof translation === "object" ? translation : {};
  const defined = normalizeVendorEntry(entry);
  return normalizeTranslationConfig({
    ...current,
    provider: defined.provider,
    baseUrl: defined.baseUrl,
    model: defined.model,
    apiKey: defined.apiKey,
    baseUrls: { ...current.baseUrls, [defined.provider]: defined.baseUrl },
    models: { ...current.models, [defined.provider]: defined.model },
    apiKeys: { ...current.apiKeys, [defined.provider]: defined.apiKey }
  });
}

/** 把命名配置套用到提取小节上:只覆盖服务商字段,vendor/followTranslation 原样保留
 * （不能用 applyVendorEntry——它走翻译配置归一化,会把这两个字段洗掉）。 */
export function overlayVendorEntry(section, entry) {
  const current = section && typeof section === "object" ? section : {};
  const defined = normalizeVendorEntry(entry);
  return {
    ...current,
    provider: defined.provider,
    baseUrl: defined.baseUrl,
    model: defined.model,
    apiKey: defined.apiKey
  };
}

/** 库内是否已有语义完全相同的条目:迁移时复用它,避免留下一堆重复配置。 */
export function findVendorByName(vendors, entry) {
  const defined = normalizeVendorEntry(entry);
  return Object.keys(vendors || {}).find(name => {
    const item = vendors[name];
    return item.provider === defined.provider && item.baseUrl === defined.baseUrl
      && item.model === defined.model && item.apiKey === defined.apiKey;
  }) || "";
}

/** 唯一名称:重名追加「 2」「 3」…（配置库按名称索引,重名会互相覆盖）。 */
export function uniqueVendorName(vendors, base) {
  const root = String(base || "").trim() || "配置";
  if (!vendors[root]) return root;
  for (let index = 2; ; index += 1) {
    const candidate = `${root} ${index}`;
    if (!vendors[candidate]) return candidate;
  }
}

/** 提取小节指向某条配置:清掉只属于旧版「自己填一份」的服务商/地址/密钥。
 *  provider 也要清——留着它归一化时会按该服务商的预设地址把 baseUrl 填回来,
 *  被引用的配置删掉后就变成「悄悄用预设服务」而不是「没有可用 AI 服务」。 */
function withVendor(section, name, normalize) {
  return normalize({
    ...section,
    vendor: name,
    followTranslation: false,
    provider: "",
    baseUrl: "",
    apiKey: "",
    baseUrls: {},
    apiKeys: {}
  });
}

/** 遍历两个提取小节,返回新对象与「是否有改动」,交给调用方决定要不要落盘。 */
function mapSections(sections, mapper) {
  const next = {};
  let changed = false;
  for (const [name, section] of Object.entries(sections || {})) {
    const mapped = mapper(section || {});
    next[name] = mapped;
    if (mapped !== section) changed = true;
  }
  return { sections: next, changed };
}

/** 配置改名:引用了旧名的提取小节一起改成新名。 */
export function remapExtractionVendor(sections, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return { sections, changed: false };
  return mapSections(sections, section => section.vendor === oldName ? { ...section, vendor: newName } : section);
}

/** 被引用的配置被删除:重指到剩下的配置;一条都不剩就清空（提取随之不可用）。 */
export function reassignExtractionVendor(sections, removedName, fallbackName) {
  if (!removedName) return { sections, changed: false };
  return mapSections(sections, section => section.vendor === removedName
    ? { ...section, vendor: String(fallbackName || "") }
    : section);
}

/** 新建/首次保存配置后,让还没选过配置的提取小节自动用上它——三个服务共用一套配置。 */
export function adoptVendorForEmptySections(sections, name) {
  if (!name) return { sections, changed: false };
  return mapSections(sections, section => section.vendor
    ? section
    : { ...section, vendor: name, followTranslation: false });
}

/**
 * 一次性迁移:把旧版「跟随翻译服务 / 自己填一份」的提取配置收敛成配置库引用。
 *
 * 1. 库空且翻译服务已配好 → 用翻译配置播种「默认配置」,并在下面把跟随的小节指向它;
 * 2. 小节还在跟随（followTranslation !== false）→ 明确指向库里的激活条目;
 * 3. 小节关掉跟随且自己填过地址 → 注册成一条命名配置（同值复用,重名加序号）。
 *
 * 返回新的 state/sections 与 changed;函数不改动入参,store 只在 changed 时落盘。
 */
export function migrateExtractionVendors({ sections, state, translation, translationConfigured }) {
  const vendors = { ...state.vendors };
  let active = state.active;
  let changed = false;

  if (Object.keys(vendors).length === 0 && translationConfigured === true) {
    const seeded = uniqueVendorName(vendors, DEFAULT_VENDOR_NAME);
    vendors[seeded] = normalizeVendorEntry(translation);
    active = seeded;
    changed = true;
  }

  const legacySections = {};
  for (const name of Object.keys(EXTRACTION_SECTIONS)) {
    const normalize = SECTION_NORMALIZERS[name];
    const section = sections[name] || {};
    // vendor 指向已不存在的条目（手改存储/删库残留）→ 当作没选过,继续走迁移分支
    const selected = section.vendor && vendors[section.vendor] ? section.vendor : "";
    if (selected) {
      legacySections[name] = section;
      continue;
    }
    if (section.followTranslation === false) {
      if (!section.baseUrl) {
        legacySections[name] = section;
        continue;
      }
      const existing = findVendorByName(vendors, section);
      const label = `${llmProviders.providerLabel(section.provider) || "自定义"} · ${EXTRACTION_SECTIONS[name]}`;
      const created = existing || uniqueVendorName(vendors, label);
      if (!vendors[created]) vendors[created] = normalizeVendorEntry(section);
      legacySections[name] = withVendor(section, created, normalize);
      changed = true;
      continue;
    }
    if (active && vendors[active]) {
      legacySections[name] = withVendor(section, active, normalize);
      changed = true;
      continue;
    }
    legacySections[name] = section;
  }

  return { state: { ...state, vendors, active }, sections: legacySections, changed };
}
