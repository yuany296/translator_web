import { createConfigurationStore, toLegacySettings } from "../config/store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createOcrProviders } from "./providers/ocr.js";
import { createTranslationProviders } from "./providers/translation.js";
import { OCR_COORDINATE_MODEL_VERSION, OCR_GEOMETRY_VERSION } from "../config/versions.js";
import languages from "../shared/languages.js";
import thinkingMode from "../shared/thinking-mode.js";

/** 服务商配置操作统一包装:业务错误返回 {ok:false, error},避免消息通道断开 */
async function runVendorOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    return { ok: false, error: error.message || "服务商配置操作失败" };
  }
}

export function configureBackgroundRuntime(runtime) {
  runtime.LOCAL_OCR_GEOMETRY_VERSION = OCR_GEOMETRY_VERSION;
  runtime.OCR_COORDINATE_MODEL_VERSION = OCR_COORDINATE_MODEL_VERSION;
  const store = createConfigurationStore(runtime);
  const ocrProviders = createOcrProviders(runtime, new ProviderRegistry("ocr"));
  const translationProviders = createTranslationProviders(runtime, new ProviderRegistry("translation"));
  runtime.configurationStore = store;
  runtime.ocrProviders = ocrProviders;
  runtime.translationProviders = translationProviders;
  runtime.ensureDefaultSettings = () => store.ensure();
  runtime.loadConfiguration = () => store.load();
  runtime.loadSettings = async () => toLegacySettings(await store.load());
  runtime.validateOcrOnlySettings = (settings) => ocrProviders.get(settings.ocrProvider).validate(settings.ocrConfig);
  runtime.requestProviderNeutralOcr = ({ request, settings }) => {
    if (runtime.backgroundTestHooks?.requestProviderNeutralOcr) {
      return runtime.backgroundTestHooks.requestProviderNeutralOcr({
        request,
        settings: { ...settings, provider: settings.ocrProvider }
      });
    }
    return ocrProviders.get(settings.ocrProvider).recognize({ request, settings });
  };
  runtime.requestCanonicalTranslationBatch = async (args) => {
    if (runtime.backgroundTestHooks?.requestCanonicalTranslationBatch) {
      return runtime.backgroundTestHooks.requestCanonicalTranslationBatch(args);
    }
    const config = await store.load();
    // 配置里的 provider 是 UI 预设(各家 OpenAI 兼容服务),运行时只有一个 OpenAI 兼容实现。
    const provider = translationProviders.get("openai_compatible");
    const error = provider.validate(config.translation);
    if (error) throw new Error(error);
    // 思考字段在这里算好（配置已经读过了，provider 侧再读一次就是白读一遍 storage）。
    // 用的是纯函数，不依赖任何运行时助手 —— 这个接缝只做「读配置 + 转交」，
    // 端点被拒时的记忆与重发都在 provider 侧的统一回落助手里。
    return provider.translateBatch({
      ...args,
      thinkingFields: thinkingMode.thinkingBodyFields(config.translation.thinkingMode, config.translation.provider)
    });
  };

  const handleLegacyMessage = runtime.handleMessage;
  runtime.handleMessage = async (message, sender) => {
    if (message.type === "GET_CONFIGURATION") return { ok: true, configuration: await store.load() };
    if (message.type === "SAVE_CONFIGURATION") {
      if (message.section === "translation") {
        const value = message.value || {};
        if (languages.isSameLanguagePair(value.sourceLanguage, value.targetLanguage)) {
          return { ok: false, error: "原文语言与目标语言不能相同（简体与繁体互转除外）" };
        }
      }
      return { ok: true, section: message.section, value: await store.save(message.section, message.value) };
    }
    // ── 翻译服务商命名配置(选服务商 → 填 Key/Model → 命名 → 保存) ──
    if (message.type === "GET_TRANSLATION_VENDORS") {
      return { ok: true, ...await store.getTranslationVendors() };
    }
    if (message.type === "SAVE_TRANSLATION_VENDOR") {
      // originalName 表示「编辑并改名」:引用旧名的提取小节会一起改成新名
      return runVendorOperation(
        () => store.saveTranslationVendor(message.name, message.entry, message.originalName)
          .then(name => ({ ok: true, name }))
      );
    }
    if (message.type === "ACTIVATE_TRANSLATION_VENDOR") {
      return runVendorOperation(
        () => store.activateTranslationVendor(message.name).then(name => ({ ok: true, name }))
      );
    }
    if (message.type === "RENAME_TRANSLATION_VENDOR") {
      return runVendorOperation(
        () => store.renameTranslationVendor(message.oldName, message.newName).then(name => ({ ok: true, name }))
      );
    }
    if (message.type === "DELETE_TRANSLATION_VENDOR") {
      return runVendorOperation(
        () => store.deleteTranslationVendor(message.name).then(state => ({ ok: true, state }))
      );
    }
    if (message.type === "TEST_OCR_CONFIGURATION") {
      const config = await store.load();
      return ocrProviders.get(config.ocr.provider).checkHealth(config.ocr);
    }
    if (message.type === "TEST_TRANSLATION_CONFIGURATION") {
      const config = await store.load();
      return translationProviders.get("openai_compatible").checkHealth(config.translation);
    }
    if (message.type === "GET_TRANSLATION_SERVICE_STATUS") return runtime.getTranslationServiceStatus();
    if (message.type === "QUERY_TRANSLATION_SERVICE") {
      return runtime.queryTranslationService(message.recordKeys || []);
    }
    if (message.type === "SUBMIT_TRANSLATION_OPERATIONS") {
      return runtime.submitTranslationOperations(message.operations || []);
    }
    if (message.type === "IMPORT_LEGACY_TRANSLATIONS") {
      return runtime.importLegacyTranslations(message.records || []);
    }
    if (message.type === "GET_TRANSLATION_VERSIONS") {
      return runtime.getTranslationVersions(message.recordId);
    }
    if (message.type === "EXPORT_TRANSLATION_LIBRARY") return runtime.exportTranslationLibrary();
    if (message.type === "IMPORT_TRANSLATION_LIBRARY") {
      return runtime.importTranslationLibrary(message.records || []);
    }
    if (message.type === "SYNC_TRANSLATION_SERVICE") {
      return runtime.syncTranslationService(message.recordKeys || []);
    }
    if (message.type === "COMMIT_TRANSLATION_OPERATION") {
      return runtime.commitOrQueueTranslationOperation(message.operation);
    }
    return handleLegacyMessage(message, sender);
  };
  return runtime;
}
