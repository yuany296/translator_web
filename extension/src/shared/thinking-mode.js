/**
 * 「思考模式」的唯一定义处。
 *
 * 为什么需要这个开关：DeepSeek（deepseek-flash / v4-pro）、GLM 4.5+、Qwen3.5 以上
 * 的思考模式**默认就是打开的**，思维链放在 `reasoning_content` 里返回，而它的 token
 * 计在 `completion_tokens` 上 —— 于是账单里「输出」会比「输入」还大好几倍（思维链本身
 * 比译文长）。小说翻译是机械任务，思考买不来质量，只买来账单。
 *
 * 扩展此前**从不发送任何思考参数**，所以用户没有关掉它的手段；默认值 `auto` 保持
 * 这一行为不变（不发送字段 = 与服务商默认完全一致），只有用户显式选 off/on 才干预。
 *
 * 各家参数名不一样，所以按服务商选格式；认不准的一律**两种都发**（`both`），
 * 真正被拒时由 background 侧剥掉重试（见 translation-utils.js#stripOptionalTranslationFields），
 * 那条路径同时会把这个端点记下来，避免每个请求都先撞一次 400。
 */
export const THINKING_MODES = Object.freeze({ AUTO: "auto", OFF: "off", ON: "on" });

/**
 * 服务商 → 思考开关的参数名。没列出来的一律 `both`：中转站（one-api / new-api 这类）
 * 背后挂哪家模型看不出来，而它是自建小说翻译最常见的接法。
 * 两个参数名分别来自 DeepSeek/GLM 与 Qwen/百炼（见各自的「思考模式 / 深度思考」文档）。
 */
const THINKING_STYLES = Object.freeze({
  qwen: "enable_thinking",
  ollama: "enable_thinking",
  deepseek: "thinking",
  glm: "thinking",
  volces: "thinking"
});

const THINKING_VALUES = Object.freeze(Object.values(THINKING_MODES));

/** 脏值一律回 `auto`：不认识的取值不能变成「悄悄发一个服务商不认的参数」。 */
export function normalizeThinkingMode(value) {
  return THINKING_VALUES.includes(value) ? value : THINKING_MODES.AUTO;
}

export function thinkingStyle(providerId) {
  return THINKING_STYLES[String(providerId || "").trim()] || "both";
}

/**
 * 要拼进请求体的思考字段。`auto` 返回空对象 —— 调用方用展开语法，
 * 空对象等价于「一个字段都不加」，即与服务商默认完全一致。
 */
export function thinkingBodyFields(mode, providerId) {
  const normalized = normalizeThinkingMode(mode);
  if (normalized === THINKING_MODES.AUTO) return {};
  const enabled = normalized === THINKING_MODES.ON;
  const style = thinkingStyle(providerId);
  const fields = {};
  if (style === "thinking" || style === "both") {
    fields.thinking = { type: enabled ? "enabled" : "disabled" };
  }
  if (style === "enable_thinking" || style === "both") {
    fields.enable_thinking = enabled;
  }
  return fields;
}

/** body 里有没有我们加的思考字段：决定 4xx 该不该剥掉重试。 */
export function hasThinkingFields(body) {
  return Boolean(body) && ("thinking" in body || "enable_thinking" in body);
}

export default Object.freeze({
  THINKING_MODES,
  normalizeThinkingMode,
  thinkingStyle,
  thinkingBodyFields,
  hasThinkingFields
});
