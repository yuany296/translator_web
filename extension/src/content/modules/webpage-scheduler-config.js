/**
 * 网页翻译的批大小与车道数的**兜底**取值。
 *
 * 这些值只有一种来源：`shared/webpage-speed.js` 的 `WEBPAGE_SPEED_DEFAULTS`
 * （与 `config/schema.js` 的默认值同源）。以前这里写死 3 车道 / 2400 字，与配置默认的
 * 5 / 3200 不是同一套：`runtime.state` 还没读到设置时（首屏、手机版），实际生效的
 * "默认"与用户看到的默认不一致。那对数字其实是「普通档」预设
 * （`WEBPAGE_SPEED_PRESETS.normal`），不该被当成默认值。
 */
import { WEBPAGE_SPEED_DEFAULTS, WEBPAGE_SPEED_LIMITS } from "../../shared/webpage-speed.js";

export const DEFAULT_LANES = WEBPAGE_SPEED_DEFAULTS.concurrency;
export const DEFAULT_BATCH_ITEMS = WEBPAGE_SPEED_DEFAULTS.batchItems;
export const DEFAULT_BATCH_CHARS = WEBPAGE_SPEED_DEFAULTS.batchChars;

function clamp(key, value) {
  const { min, max } = WEBPAGE_SPEED_LIMITS[key];
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

export function getWebpageLanes(runtime) {
  const configured = Number(runtime?.state?.webpageConcurrency);
  return Number.isFinite(configured) ? clamp("concurrency", configured) : DEFAULT_LANES;
}

export function getWebpageBatchLimits(runtime) {
  const configuredItems = Number(runtime?.state?.webpageBatchItems);
  const configuredChars = Number(runtime?.state?.webpageBatchChars);
  const baseItems = Number.isFinite(configuredItems) ? clamp("batchItems", configuredItems) : DEFAULT_BATCH_ITEMS;
  const baseChars = Number.isFinite(configuredChars) ? clamp("batchChars", configuredChars) : DEFAULT_BATCH_CHARS;
  const minItems = WEBPAGE_SPEED_LIMITS.batchItems.min;
  const minChars = WEBPAGE_SPEED_LIMITS.batchChars.min;
  // 档位折算：视口内 1/4、近屏 1/2、后台整批（含义见 shared/webpage-speed.js）。
  const lane = factor => ({
    maxItems: Math.max(minItems, Math.floor(baseItems * factor)),
    maxChars: Math.max(minChars, Math.floor(baseChars * factor))
  });
  return Object.freeze({ 0: lane(0.25), 1: lane(0.5), 2: lane(1), 3: lane(1) });
}
