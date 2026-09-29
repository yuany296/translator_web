/**
 * 「一句话被切片边界劈成两条 canonical」的判据。
 *
 * 现场证据（`page.kakao.com/content/69229506`）：同一句
 * `다크라이드는 보통 테마파크의 테마를 설명합니다.` 在库里是两条记录——
 * `canonical_fb1d132cbfd52e5268e5998357136072`（源 `다크라이드는 보통`，译文却是整句）
 * 与 `canonical_d8546d94dc0f06b525d5651ff6ae63d8`（源 `테마파크의 테마를 설명합니다.`）。
 *
 * 这里只做**纯判定**，不碰 store、不碰网络：给定一批 canonical 和若干邻片对，
 * 找出「上片的最后一条没有结句 + 下片的第一条不是以引号/括号开头」的漏合并对。
 * 真正决定合并与否的是 reconciler，这个检测器只负责把可疑对变成可观测证据。
 */

/** 结句标点（中/日/韩/英文常见收尾），命中说明前一段自己就讲完了。 */
const TERMINAL_END_RE = /[.!?。！？…⋯~〜∼♪」』】）》”’"')\]]\s*$/u;
/** 以引号/括号开头：多半是另一个气泡，不是续句。 */
const CONTINUATION_START_RE = /^[\s"'“”‘’「『（(【《]/u;

const MIN_SEGMENT_CHARS = 4;

export function looksLikeContinuation(previousText, nextText) {
  const previous = String(previousText || "").trim();
  const next = String(nextText || "").trim();
  if (previous.length < MIN_SEGMENT_CHARS || !next) return false;
  if (TERMINAL_END_RE.test(previous)) return false;
  if (CONTINUATION_START_RE.test(next)) return false;
  return true;
}

function boxBounds(box) {
  if (!box) return null;
  if (Array.isArray(box.polygon) && box.polygon.length) {
    const ys = box.polygon.map(point => Number(point && point.y)).filter(Number.isFinite);
    if (!ys.length) return null;
    return { top: Math.min(...ys), bottom: Math.max(...ys) };
  }
  const top = Number(box.top ?? box.y);
  if (!Number.isFinite(top)) return null;
  const height = Number(box.height ?? box.h);
  return { top, bottom: Number.isFinite(height) ? top + height : top };
}

/** 某条 canonical 在指定页上的纵向范围（拿不到几何时返回 null）。 */
export function geometryYBounds(canonical, pageId) {
  const boxes = canonical && canonical.geometryByPage && canonical.geometryByPage[pageId];
  if (!Array.isArray(boxes) || boxes.length === 0) return null;
  let top = Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    const bounds = boxBounds(box);
    if (!bounds) continue;
    top = Math.min(top, bounds.top);
    bottom = Math.max(bottom, bounds.bottom);
  }
  return Number.isFinite(top) && Number.isFinite(bottom) ? { top, bottom } : null;
}

function pickExtreme(entries, direction) {
  const withBounds = entries.filter(entry => entry.bounds);
  if (withBounds.length > 0) {
    return withBounds.reduce((best, entry) => (direction === "last"
      ? entry.bounds.bottom > best.bounds.bottom ? entry : best
      : entry.bounds.top < best.bounds.top ? entry : best));
  }
  // 几何缺失时退回稳定顺序：至少能报出「这两条可能是同一句」。
  return direction === "last" ? entries[entries.length - 1] : entries[0];
}

/**
 * @param {{canonicals?: Array, pairs?: Array<{upperPageId: string, lowerPageId: string}>}} input
 * @returns {Array<{upperPageId: string, lowerPageId: string, previous: object, next: object}>}
 */
export function findSeamSplitPairs({ canonicals = [], pairs = [] } = {}) {
  const usable = (Array.isArray(canonicals) ? canonicals : []).filter(canonical =>
    canonical && canonical.status !== "filtered" && String(canonical.originalText || "").trim());
  const splits = [];
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const upperPageId = String(pair && pair.upperPageId || "");
    const lowerPageId = String(pair && pair.lowerPageId || "");
    if (!upperPageId || !lowerPageId || upperPageId === lowerPageId) continue;
    const upperOnly = [];
    const lowerOnly = [];
    for (const canonical of usable) {
      const pages = Object.keys(canonical.geometryByPage || {});
      const onUpper = pages.includes(upperPageId);
      const onLower = pages.includes(lowerPageId);
      // 已经跨片落在两条页上的 canonical 说明合并成功，不是漏合并。
      if (onUpper && onLower) continue;
      const entry = {
        id: String(canonical.id || ""),
        text: String(canonical.originalText || ""),
        status: String(canonical.status || ""),
        bounds: geometryYBounds(canonical, onUpper ? upperPageId : lowerPageId)
      };
      if (onUpper) upperOnly.push(entry);
      else if (onLower) lowerOnly.push(entry);
    }
    if (upperOnly.length === 0 || lowerOnly.length === 0) continue;
    const previous = pickExtreme(upperOnly, "last");
    const next = pickExtreme(lowerOnly, "first");
    if (!looksLikeContinuation(previous.text, next.text)) continue;
    splits.push({ upperPageId, lowerPageId, previous, next });
  }
  return splits;
}

export default Object.freeze({ looksLikeContinuation, findSeamSplitPairs, geometryYBounds });
