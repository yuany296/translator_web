/**
 * 分片长条（KakaoPage / RIDI 这类把整章拼成长条图再切片的阅读器）的**接缝带**几何。
 *
 * 接缝带 = 切片边界处按宽度比例取的一条窄带，用来做接缝处的补充 OCR。
 *
 * 这三个数值原先在三个地方各写了一份（值相同、名字不同）：
 *   - `canonical/reconciler-modules/reconciler-constants.js`（SEAM_BAND_*）
 *   - `canonical/modules/constants-fsm.js`（KAKAO_SEAM_HEIGHT_*）
 *   - `content/modules/reader-state.js`（KAKAO_SEAM_CAPTURE_*）
 * 计算式也各写了一遍。只要有一处漏改，"内容侧请求的接缝带"与"canonical 侧预期的
 * 接缝带"就会错位，表现为接缝那行时而合并、时而裂成两条。这里只留一份。
 */

export const SEAM_BAND_WIDTH_RATIO = 0.15;
export const SEAM_BAND_MIN_PX = 64;
export const SEAM_BAND_MAX_PX = 96;

/**
 * 接缝带高度：宽度 × 比例，`requestedHeight` 非 0 时用它（调用方给的是"想要的带高"，
 * 最终仍会被夹到 [MIN, MAX]）。两个分支都保留历史写法 —— `Number(requestedHeight) ||` 与
 * `Math.min(requestedHeight, …)` 在两者都落进 [MIN, MAX] 时结果不同，改法等于改行为。
 */
export function seamBandHeight(width, requestedHeight = 0) {
  const natural = (Number(width) || 0) * SEAM_BAND_WIDTH_RATIO;
  const value = Number(requestedHeight) || natural;
  return Math.max(SEAM_BAND_MIN_PX, Math.min(SEAM_BAND_MAX_PX, Math.round(value)));
}
