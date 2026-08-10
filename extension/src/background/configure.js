import { createConfigurationStore, toLegacySettings } from "../config/store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createOcrProviders } from "./providers/ocr.js";
import { createTranslationProviders } from "./providers/translation.js";
import { OCR_COORDINATE_MODEL_VERSION, OCR_GEOMETRY_VERSION } from "../config/versions.js";
import languages from "../shared/languages.js";

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
    const provider = translationProviders.get(config.translation.provider);
    const error = provider.validate(config.translation);
    if (error) throw new Error(error);
    return provider.translateBatch(args);
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
    if (message.type === "TEST_OCR_CONFIGURATION") {
      const config = await store.load();
      return ocrProviders.get(config.ocr.provider).checkHealth(config.ocr);
    }
    if (message.type === "TEST_TRANSLATION_CONFIGURATION") {
      const config = await store.load();
      return translationProviders.get(config.translation.provider).checkHealth(config.translation);
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
