/**
 * 全仓共用的 FNV-1a 哈希。
 *
 * **两种输出格式并存，且都早已进入 id 与缓存键，不可互换**：
 *   - `hashString36`：base36 输出（`Math.imul` 变体）。术语条目 id、术语库 id、
 *     术语发现证据 id、`mt_term_extract_run_v1:` 键用它。
 *   - `hashString16`：hex 输出（移位变体）。`runtime.hashString` 用它算 OCR /
 *     翻译缓存键、块 id、块级 fallback id。
 *
 * 两段实现都是逐位照搬历史代码：换算法或换进制等于让所有既有缓存键与 id 失效
 * （缓存在 7 天 TTL 内全部落空、服务端 id 与本地 id 不再相等）。要改就先想清楚
 * 迁移，别把它当"顺手统一"。
 */

/** base36 输出（16 进制以外的写法）。 */
export function hashString36(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** hex 输出。注意：与 hashString36 一样不做 `String()` 兜底，保持与历史调用一致。 */
export function hashString16(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}
