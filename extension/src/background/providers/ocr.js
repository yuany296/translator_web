import { OCR_PROVIDERS, normalizeOcrConfig } from "../../config/schema.js";

export function createOcrProviders(runtime, registry) {
  registry.register({
    id: OCR_PROVIDERS.BAIDU,
    normalizeConfig: normalizeOcrConfig,
    validate(config) {
      const normalized = normalizeOcrConfig(config);
      return normalized.baidu.apiKey && normalized.baidu.secretKey ? "" : "百度 OCR AK/SK 未配置";
    },
    async checkHealth(config) {
      const error = this.validate(config);
      return error ? { ok: false, error } : { ok: true, provider: this.id };
    },
    recognize({ request, settings }) {
      return runtime.requestBaiduOcrObservations({ request, settings });
    }
  });

  registry.register({
    id: OCR_PROVIDERS.LOCAL_PADDLE,
    normalizeConfig: normalizeOcrConfig,
    validate(config) {
      const normalized = normalizeOcrConfig(config);
      if (!normalized.localPaddle.baseUrl) return "本地 OCR 服务地址未配置";
      if (normalized.visionRepair.enabled && !normalized.visionRepair.apiKey) return "Vision OCR API Key 未配置";
      return "";
    },
    async checkHealth(config) {
      const normalized = normalizeOcrConfig(config);
      const error = this.validate(normalized);
      if (error) return { ok: false, error };
      try {
        const { response, payload } = await runtime.fetchJsonWithTimeout(`${normalized.localPaddle.baseUrl}/health`, {}, {
          timeoutMs: 5000, timeoutMessage: "本地 OCR 服务连接超时"
        });
        return response.ok ? { ok: true, provider: this.id, details: payload } : { ok: false, error: `HTTP ${response.status}` };
      } catch (healthError) {
        return { ok: false, error: runtime.getErrorMessage(healthError) };
      }
    },
    recognize({ request, settings }) {
      return runtime.requestLocalPaddleOcrObservations({ request, settings });
    }
  });
  return registry;
}
