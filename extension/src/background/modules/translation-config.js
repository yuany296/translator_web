import cacheCore from "../../shared/translation-cache.js";

/**
 * Current translation configuration fingerprint for each mode. The content
 * script asks for it when querying or saving page-level translation caches,
 * so a model / prompt / glossary change is recognized instead of silently
 * reusing an old-configuration translation. Secrets never enter the
 * fingerprint.
 */
export function installTranslationConfig(runtime) {
  runtime.buildTranslationConfigFingerprint = cacheCore.buildTranslationConfigFingerprint;

  async function getTranslationConfigFingerprint(mode = "novel") {
    const normalizedMode = mode === "webpage" ? "webpage" : mode === "comic" ? "comic" : "novel";
    const promptVersion = normalizedMode === "webpage"
      ? runtime.WEBPAGE_TRANSLATION_PROMPT_VERSION
      : normalizedMode === "comic"
        ? runtime.CANONICAL_TRANSLATION_PROMPT_VERSION
        : runtime.NOVEL_TRANSLATION_PROMPT_VERSION || "kakao-novel-v1";
    try {
      const settings = await runtime.loadSettings();
      return cacheCore.buildTranslationConfigFingerprint({
        provider: "openai-compatible",
        model: settings.model || runtime.DEFAULT_TRANSLATION_MODEL,
        sourceLanguage: settings.sourceLanguage || "auto",
        targetLanguage: settings.targetLanguage || "zh-CN",
        promptVersion,
        glossaryVersion: runtime.glossaryCore.getFingerprint(settings.glossary, { scopeKey: "" })
      });
    } catch (error) {
      console.warn("[MangaTranslator] config fingerprint unavailable", runtime.getErrorMessage(error));
      return "";
    }
  }
  runtime.getTranslationConfigFingerprint = getTranslationConfigFingerprint;
}
