/**
 * 采样背景色的**单一定义**：`#rgb` / `#rrggbb`（大小写不敏感）→ 小写 `#rrggbb`，
 * 其余（空串、`rgb()`、`none`、服务端缺字段）一律 ""。
 *
 * 所有「从一组候选里取第一份有效采样色」的判据必须共用这把尺子 —— 服务端采样、
 * 客户端采样、接缝配对、区域组合并、canonical 接缝面各写一份正则，分叉不会报错，
 * 只会让某一层把另一层刚量到的颜色判成"没有颜色"（现场症状：跨页盖板整块透明、
 * 原文赤裸地留在译文下面）。
 */

export function normalizeSolidColor(value) {
  const text = String(value || "").trim();
  const full = /^#([0-9a-f]{6})$/iu.exec(text);
  if (full) return `#${full[1].toLowerCase()}`;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(text);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase() : "";
}

/** 一组候选（允许夹带空值/非法值）里的第一份有效采样色；都没有返回 ""。 */
export function firstSolidColor(values) {
  for (const value of Array.isArray(values) ? values : []) {
    const hex = normalizeSolidColor(value);
    if (hex) return hex;
  }
  return "";
}

/**
 * 观测的采样背景色：只有它自己声明实底（`bgType/bg_type === "solid"`）才作数。
 * 复杂背景观测的颜色是插画采样的兜底色，拿来给实底盖板上色只会糊错地方。
 */
export function solidObservationColor(observation) {
  const visual = observation && observation.visual;
  if (!visual || typeof visual !== "object") return "";
  if (String(visual.bgType || visual.bg_type || "").trim().toLowerCase() !== "solid") return "";
  return normalizeSolidColor(visual.bgColor || visual.bg_color);
}
