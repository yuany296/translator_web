import llmProviders from "../shared/llm-providers.js";
import { normalizeTermExtractionEngine } from "./schema.js";
import { resolveExtractionConfig } from "./store.js";

/**
 * 「整章术语提取」实际会走哪条路。纯函数，不读 storage、不发请求——后台分派与设置页提示
 * 都用这一份判断，避免两处各写一套文案后漂掉。
 *
 * 三档语义（存在 termExtraction.engine）：
 * - auto：有可用的 AI 配置就用 AI，否则用本地（= 改动前的行为，老存档零变化）
 * - local：强制不发 AI 请求，走本地服务（模型缺失时服务端不再产出任何候选）
 * - ai：强制走 AI；没配置好就 effective=none，由调用方跳过并说明，不静默回退
 */
export const TERM_ENGINE_INPUT_IDS = Object.freeze({
  auto: "termEngineAuto",
  local: "termEngineLocal",
  ai: "termEngineAi"
});

function aiLabel(resolved) {
  const vendor = String((resolved && resolved.vendor) || "").trim();
  if (vendor) return `配置「${vendor}」`;
  return llmProviders.providerLabel(String((resolved && resolved.provider) || ""))
    || String((resolved && resolved.model) || "").trim() || "AI";
}

export function describeTermExtractionEngine(configuration = {}) {
  const section = (configuration && configuration.termExtraction) || {};
  const configured = normalizeTermExtractionEngine(section.engine);
  const resolved = resolveExtractionConfig(configuration, "termExtraction");
  const baseUrl = String((resolved && resolved.baseUrl) || "").trim();
  if (configured === "local") {
    return { configured, effective: "local", llm: null, reason: "已选「本地模型」：不会发送 AI 请求" };
  }
  if (configured === "ai") {
    return baseUrl
      ? { configured, effective: "ai", llm: resolved, reason: `已选「AI 配置」：使用${aiLabel(resolved)}` }
      : { configured, effective: "none", llm: null, reason: "已选「AI 配置」但没有可用配置，提取会跳过" };
  }
  return baseUrl
    ? { configured, effective: "ai", llm: resolved, reason: `自动：使用${aiLabel(resolved)}` }
    : { configured, effective: "local", llm: null, reason: "自动：没有可用的 AI 配置，改用本地模型" };
}
