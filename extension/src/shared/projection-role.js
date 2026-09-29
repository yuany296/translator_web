/**
 * `projection.role` 的归一与"是不是遮罩"判据 —— 只此一份。
 *
 * canonical 侧产出的 role 是 `primary` / `standby` / `cover`，而渲染侧与投影筛选只认
 * `text_primary` / `text_standby` / `cover_only`。这段映射原先在三个地方各写了一遍
 * （content 的 scene-canonical、scene-projection，以及 configure.js 里的遮罩判据），
 * 其中 scene-canonical 的两处**语义还不一致**：同一个 `standby + coverOnly` 投影，
 * 一处判成遮罩、一处判成文字候选 —— 表现就是同一块内容既被当遮罩又被选去做文字渲染。
 */

/** 归一后的 role：text_primary / text_standby / cover_only / 其它原样。 */
export function normalizeProjectionRole(rawRole, coverOnly) {
  const role = String(rawRole || "text_primary");
  if (role === "primary") return "text_primary";
  if (role === "standby") return coverOnly === true ? "cover_only" : "text_standby";
  if (role === "cover") return "cover_only";
  return role;
}

/**
 * 这个投影是不是"只负责遮罩"。
 * 注意与 normalizeProjectionRole 的区别：**只看 coverOnly 标记，不看 role**，
 * 所以 `role: "text_primary"` + `coverOnly: true` 在这里算遮罩（历史语义，保持不变）。
 */
export function isCoverProjection(projection) {
  return projection?.role === "cover" || projection?.role === "cover_only" || projection?.coverOnly === true;
}
