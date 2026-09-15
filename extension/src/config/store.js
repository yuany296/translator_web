import {
  CONFIG_KEYS, OCR_PROVIDERS, DEFAULT_TRANSLATION_CONFIG, normalizeOcrConfig,
  normalizeRuntimeConfig, normalizeTranslationConfig,
  normalizeTermExtractionConfig, normalizeSentenceExtractionConfig
} from "./schema.js";
import languages from "../shared/languages.js";
import llmProviders from "../shared/llm-providers.js";
import {
  VENDORS_KEY, adoptVendorForEmptySections, applyVendorEntry, migrateExtractionVendors,
  normalizeVendorEntry, normalizeVendorsState, overlayVendorEntry, reassignExtractionVendor,
  remapExtractionVendor
} from "./vendors.js";

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * 翻译服务是不是「真的配好了」：填了密钥，或者是免密钥服务商且地址不是内置默认值。
 * 用来决定提取类配置能不能跟着翻译服务走——没配好时跟着走会拿一个没有密钥的服务去请求。
 */
export function isTranslationConfigured(configuration) {
  const translation = configuration && configuration.translation || {};
  if (translation.apiKey) {
    return true;
  }
  return !llmProviders.keyRequired(translation.provider)
    && Boolean(translation.baseUrl)
    && translation.baseUrl !== DEFAULT_TRANSLATION_CONFIG.baseUrl;
}

/**
 * 术语提取 / 句子级提取的有效配置：优先用配置库里选定的那一条
 * （`section.vendor`，三个 LLM 服务共用同一套命名配置）；
 * 兼容旧存档：还在「跟随翻译服务」时直接用翻译那一套，否则用它自己存的那一份。
 */
export function resolveExtractionConfig(configuration, sectionName) {
  const section = configuration && configuration[sectionName] || {};
  const vendors = configuration && configuration.llmVendors && configuration.llmVendors.vendors || {};
  const entry = section.vendor ? vendors[section.vendor] : null;
  if (entry) {
    return overlayVendorEntry(section, entry);
  }
  if (section.followTranslation === false || !isTranslationConfigured(configuration)) {
    return section;
  }
  const translation = configuration && configuration.translation || {};
  return {
    ...section,
    provider: translation.provider || section.provider || "",
    baseUrl: translation.baseUrl || "",
    model: translation.model || section.model || "",
    apiKey: translation.apiKey || ""
  };
}

function normalizeUnifiedConfiguration(raw) {
  const rawOcr = raw[CONFIG_KEYS.ocr] || {};
  const rawTranslation = raw[CONFIG_KEYS.translation] || {};
  const migratedSource = hasOwn(rawTranslation, "sourceLanguage")
    ? rawTranslation.sourceLanguage
    : languages.ocrLanguageToTranslationLanguage(rawOcr.localPaddle?.lang, "auto");
  const translation = normalizeTranslationConfig({ ...rawTranslation, sourceLanguage: migratedSource });
  const ocr = normalizeOcrConfig(rawOcr);
  ocr.localPaddle.lang = languages.translationLanguageToOcrLanguage(translation.sourceLanguage);
  return {
    ocr,
    translation,
    runtime: normalizeRuntimeConfig(raw[CONFIG_KEYS.runtime]),
    termExtraction: normalizeTermExtractionConfig(raw[CONFIG_KEYS.termExtraction]),
    sentenceExtraction: normalizeSentenceExtractionConfig(raw[CONFIG_KEYS.sentenceExtraction])
  };
}

export function createConfigurationStore({ storageGet, storageSet, glossaryCore }) {
  async function load() {
    const keys = [CONFIG_KEYS.ocr, CONFIG_KEYS.translation, CONFIG_KEYS.runtime,
      CONFIG_KEYS.termExtraction, CONFIG_KEYS.sentenceExtraction, VENDORS_KEY, glossaryCore.STORAGE_KEY];
    if (glossaryCore.LEGACY_STORAGE_KEY) keys.push(glossaryCore.LEGACY_STORAGE_KEY);
    const raw = await storageGet(keys);
    const storedGlossary = raw[glossaryCore.STORAGE_KEY] ?? raw[glossaryCore.LEGACY_STORAGE_KEY];
    const glossary = glossaryCore.normalizeGlossary(storedGlossary);
    const unified = normalizeUnifiedConfiguration(raw);
    // 激活的命名服务商配置覆盖服务商字段(语言等其余字段保留)
    let vendorsState = normalizeVendorsState(raw[VENDORS_KEY]);
    if (vendorsState.active && vendorsState.vendors[vendorsState.active]) {
      unified.translation = applyVendorEntry(unified.translation, vendorsState.vendors[vendorsState.active]);
    }
    // 三个 LLM 服务共用一套命名配置:把旧版提取配置收敛成配置库引用
    const migration = migrateExtractionVendors({
      sections: { termExtraction: unified.termExtraction, sentenceExtraction: unified.sentenceExtraction },
      state: vendorsState,
      translation: unified.translation,
      translationConfigured: isTranslationConfigured(unified)
    });
    vendorsState = migration.state;
    unified.termExtraction = migration.sections.termExtraction;
    unified.sentenceExtraction = migration.sections.sentenceExtraction;
    // 迁移是幂等的:落盘后下次 load 的小节已带 vendor,changed 自然为 false,不会再写
    if (migration.changed) {
      await storageSet({
        [VENDORS_KEY]: vendorsState,
        [CONFIG_KEYS.termExtraction]: unified.termExtraction,
        [CONFIG_KEYS.sentenceExtraction]: unified.sentenceExtraction
      });
    }
    if (raw[glossaryCore.STORAGE_KEY] === undefined && storedGlossary !== undefined) {
      await storageSet({ [glossaryCore.STORAGE_KEY]: glossary });
    }
    return {
      ...unified,
      glossary,
      glossaryFingerprint: glossaryCore.getFingerprint(glossary),
      // 供 resolveExtractionConfig 查表;不落盘,toLegacySettings 也不会带出去
      llmVendors: { vendors: vendorsState.vendors, active: vendorsState.active }
    };
  }

  async function ensure() {
    const config = await load();
    await storageSet({
      [CONFIG_KEYS.ocr]: config.ocr,
      [CONFIG_KEYS.translation]: config.translation,
      [CONFIG_KEYS.runtime]: config.runtime,
      [CONFIG_KEYS.termExtraction]: config.termExtraction,
      [CONFIG_KEYS.sentenceExtraction]: config.sentenceExtraction,
      [glossaryCore.STORAGE_KEY]: config.glossary
    });
    return config;
  }

  async function save(section, value) {
    const normalizers = {
      ocr: normalizeOcrConfig,
      translation: normalizeTranslationConfig,
      runtime: normalizeRuntimeConfig,
      termExtraction: normalizeTermExtractionConfig,
      sentenceExtraction: normalizeSentenceExtractionConfig
    };
    if (!normalizers[section]) throw new Error(`Unknown configuration section: ${section}`);
    const normalized = normalizers[section](value);
    await storageSet({ [CONFIG_KEYS[section]]: normalized });
    // 翻译配置保存后同步当前激活的命名服务商配置,保证条目与表单一致
    if (section === "translation") {
      const vendorsState = normalizeVendorsState((await storageGet([VENDORS_KEY]))[VENDORS_KEY]);
      if (vendorsState.active) {
        vendorsState.vendors[vendorsState.active] = normalizeVendorEntry(normalized);
        await storageSet({ [VENDORS_KEY]: vendorsState });
      }
    }
    return normalized;
  }

  // ── LLM 服务命名配置(选服务商 → 填 Key/Model → 命名 → 保存,三个 LLM 服务共用) ──

  async function readVendorsState() {
    return normalizeVendorsState((await storageGet([VENDORS_KEY]))[VENDORS_KEY]);
  }

  async function readExtractionSections() {
    const raw = await storageGet([CONFIG_KEYS.termExtraction, CONFIG_KEYS.sentenceExtraction]);
    return {
      termExtraction: normalizeTermExtractionConfig(raw[CONFIG_KEYS.termExtraction]),
      sentenceExtraction: normalizeSentenceExtractionConfig(raw[CONFIG_KEYS.sentenceExtraction])
    };
  }

  /** 配置改名/删除/新增后同步两个提取小节的引用,否则界面与运行时会指向不存在的条目 */
  async function applyExtractionSections(result) {
    if (!result.changed) return;
    await storageSet({
      [CONFIG_KEYS.termExtraction]: result.sections.termExtraction,
      [CONFIG_KEYS.sentenceExtraction]: result.sections.sentenceExtraction
    });
  }

  async function getTranslationVendors() {
    const state = await readVendorsState();
    // usage 给设置页的「管理配置档案」表用：一眼看到某套配置被哪几个服务用着，
    // 删之前就知道会影响谁（三个服务共用这一个命名配置库）。
    const sections = await readExtractionSections();
    const usage = {};
    const markUsed = (name, kind) => {
      const key = String(name || "").trim();
      if (!key) return;
      if (!usage[key]) usage[key] = [];
      if (!usage[key].includes(kind)) usage[key].push(kind);
    };
    markUsed(state.active, "translation");
    markUsed(sections.termExtraction?.vendor, "termExtraction");
    markUsed(sections.sentenceExtraction?.vendor, "sentenceExtraction");
    // entries 供设置页「编辑」回填：与 GET_CONFIGURATION 同等暴露范围（仅本机选项页）
    return { names: Object.keys(state.vendors).sort(), active: state.active, entries: state.vendors, usage };
  }

  /** 把激活条目的服务商字段同步到 legacy 翻译键(保留语言等其余字段) */
  async function syncLegacyTranslation(activeName, state) {
    const entry = state.vendors[activeName];
    if (!entry) return;
    const current = (await storageGet([CONFIG_KEYS.translation]))[CONFIG_KEYS.translation] || {};
    await storageSet({ [CONFIG_KEYS.translation]: applyVendorEntry(current, entry) });
  }

  /** 保存(新增或覆盖)命名配置并激活;首次保存时备份原翻译配置。
   * 传 originalName 表示「编辑并改名」:旧条目摘掉,引用旧名的提取小节一起改成新名。 */
  async function saveTranslationVendor(name, entry, originalName = "") {
    const key = String(name || "").trim();
    if (!key) throw new Error("配置名称不能为空");
    const original = String(originalName || "").trim();
    const state = await readVendorsState();
    const isFirst = Object.keys(state.vendors).length === 0 && !state.baseline;
    if (original && original !== key && state.vendors[original]) {
      delete state.vendors[original];
      if (state.active === original) state.active = "";
      await applyExtractionSections(remapExtractionVendor(await readExtractionSections(), original, key));
    }
    state.vendors[key] = normalizeVendorEntry(entry);
    state.active = key;
    if (isFirst) {
      const current = (await storageGet([CONFIG_KEYS.translation]))[CONFIG_KEYS.translation] || {};
      state.baseline = normalizeVendorEntry(current);
    }
    await storageSet({ [VENDORS_KEY]: state });
    await syncLegacyTranslation(key, state);
    // 还没选过配置的提取小节自动用上这一条:三个服务共用一套配置
    await applyExtractionSections(adoptVendorForEmptySections(await readExtractionSections(), key));
    return key;
  }

  async function activateTranslationVendor(name) {
    const state = await readVendorsState();
    const key = String(name || "").trim();
    if (!state.vendors[key]) throw new Error(`服务商配置不存在：${key}`);
    state.active = key;
    await storageSet({ [VENDORS_KEY]: state });
    await syncLegacyTranslation(key, state);
    await applyExtractionSections(adoptVendorForEmptySections(await readExtractionSections(), key));
    return key;
  }

  async function renameTranslationVendor(oldName, newName) {
    const state = await readVendorsState();
    const source = String(oldName || "").trim();
    const target = String(newName || "").trim();
    if (!source || !target) throw new Error("配置名称不能为空");
    if (source === target) return target;
    if (!state.vendors[source]) throw new Error(`服务商配置不存在：${source}`);
    if (state.vendors[target]) throw new Error(`服务商配置已存在：${target}`);
    state.vendors[target] = state.vendors[source];
    delete state.vendors[source];
    if (state.active === source) state.active = target;
    await storageSet({ [VENDORS_KEY]: state });
    await applyExtractionSections(remapExtractionVendor(await readExtractionSections(), source, target));
    if (state.active) await syncLegacyTranslation(state.active, state);
    return target;
  }

  /** 删除命名配置;删除激活条目时切到剩余第一个,无剩余则恢复首次保存前的翻译配置。
   * 引用了这条配置的提取小节重指到剩余配置,一条都不剩才清空（提取随之不可用）。 */
  async function deleteTranslationVendor(name) {
    const state = await readVendorsState();
    const key = String(name || "").trim();
    if (!key || !state.vendors[key]) return getTranslationVendors();
    delete state.vendors[key];
    if (state.active === key) {
      const remaining = Object.keys(state.vendors);
      state.active = remaining.length ? remaining[0] : "";
    }
    await storageSet({ [VENDORS_KEY]: state });
    await applyExtractionSections(reassignExtractionVendor(await readExtractionSections(), key, state.active));
    if (state.active) {
      await syncLegacyTranslation(state.active, state);
    } else if (state.baseline) {
      // 全部删除:恢复首次保存命名配置前的翻译配置,避免覆盖用户原配置
      const current = (await storageGet(CONFIG_KEYS.translation))[CONFIG_KEYS.translation] || {};
      await storageSet({ [CONFIG_KEYS.translation]: applyVendorEntry(current, state.baseline) });
      state.baseline = null;
      await storageSet({ [VENDORS_KEY]: state });
    }
    return getTranslationVendors();
  }

  return Object.freeze({
    load, ensure, save,
    getTranslationVendors, saveTranslationVendor, activateTranslationVendor,
    renameTranslationVendor, deleteTranslationVendor
  });
}

export function toLegacySettings(config) {
  const { ocr, translation, runtime, glossary, glossaryFingerprint } = config;
  const local = ocr.localPaddle;
  const tuning = ocr.tuning;
  const vision = ocr.visionRepair;
  return {
    provider: ocr.provider,
    ocrProvider: ocr.provider, translationProvider: translation.provider,
    model: translation.model, apiKey: translation.apiKey, baseUrl: translation.baseUrl,
    sourceLanguage: translation.sourceLanguage, targetLanguage: translation.targetLanguage,
    baiduApiKey: ocr.baidu.apiKey, baiduSecretKey: ocr.baidu.secretKey,
    localOcrBaseUrl: local.baseUrl,
    localOcrLang: languages.translationLanguageToOcrLanguage(translation.sourceLanguage),
    localOcrMode: local.mode,
    localOcrDetThresh: local.detThresh, localOcrDetBoxThresh: local.detBoxThresh,
    localOcrDetUnclipRatio: local.detUnclipRatio, localOcrDebug: local.debug,
    ocrConfidenceThreshold: tuning.confidenceThreshold, ocrMinBoxArea: tuning.minBoxArea,
    ocrMaxBoxArea: tuning.maxBoxArea, ocrMinBoxWidth: tuning.minBoxWidth,
    ocrMinBoxHeight: tuning.minBoxHeight, ocrMaxAspectRatio: tuning.maxAspectRatio,
    ocrMergeLineGap: tuning.mergeLineGap,
    ocrNovelImageMergeLines: tuning.novelImageMergeLines === true,
    visionOcrEnabled: vision.enabled, visionOcrApiKey: vision.apiKey,
    visionOcrBaseUrl: vision.baseUrl, visionOcrModel: vision.model,
    ...runtime, glossary, glossaryEntries: glossary.entries, glossaryFingerprint,
    ocrConfig: ocr, translationConfig: translation, runtimeConfig: runtime
  };
}
