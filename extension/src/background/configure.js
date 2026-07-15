import { createConfigurationStore, toLegacySettings } from "../config/store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createOcrProviders } from "./providers/ocr.js";
import { createTranslationProviders } from "./providers/translation.js";

export function configureBackgroundRuntime(runtime) {
  runtime.LOCAL_OCR_GEOMETRY_VERSION = "detect-crop-recognize-v1";
  runtime.OCR_COORDINATE_MODEL_VERSION = "crop-source-transform-v1";
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
    if (message.type === "TRANSLATE_DATA_URL") {
      return { ok: false, error: "TRANSLATE_DATA_URL 已移除；请依次调用 OCR_DATA_URL 与 TRANSLATE_TEXT_BLOCKS" };
    }
    return handleLegacyMessage(message, sender);
  };
  return runtime;
}
