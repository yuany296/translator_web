import { TRANSLATION_PROVIDERS, normalizeTranslationConfig } from "../../config/schema.js";
import languages from "../../shared/languages.js";

export function createTranslationProviders(runtime, registry) {
  registry.register({
    id: TRANSLATION_PROVIDERS.OPENAI_COMPATIBLE,
    normalizeConfig: normalizeTranslationConfig,
    validate(config) {
      const normalized = normalizeTranslationConfig(config);
      if (!normalized.apiKey) return "翻译 API Key 未配置";
      if (!normalized.model) return "翻译模型未配置";
      if (languages.isSameLanguagePair(normalized.sourceLanguage, normalized.targetLanguage)) {
        return "源语言与目标语言不能相同（简体与繁体互转除外）";
      }
      return "";
    },
    async checkHealth(config) {
      const normalized = normalizeTranslationConfig(config);
      const error = this.validate(normalized);
      if (error) return { ok: false, error };
      const endpoint = `${normalized.baseUrl.replace(/\/+$/u, "")}/models`;
      try {
        const { response } = await runtime.fetchJsonWithTimeout(endpoint, {
          headers: { Authorization: `Bearer ${normalized.apiKey}` }
        }, { timeoutMs: 8000, timeoutMessage: "翻译服务连接超时" });
        return response.ok ? { ok: true, provider: this.id } : { ok: false, error: `HTTP ${response.status}` };
      } catch (healthError) {
        return { ok: false, error: runtime.getErrorMessage(healthError) };
      }
    },
    translateBatch(args) {
      return runtime.requestOpenAICompatibleCanonicalTranslationBatch(args);
    },
    fingerprint(config) {
      const normalized = normalizeTranslationConfig(config);
      return runtime.stableHash128(`${this.id}|${normalized.baseUrl}|${normalized.model}`);
    }
  });
  return registry;
}
