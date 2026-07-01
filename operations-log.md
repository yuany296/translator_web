# operations-log

## 2026-07-01 — 修复 KakaoPage 跨页接缝重复翻译

- 执行者：Codex
- 现场证据：同一接缝处同时存在两个高度重叠的 `.mt-bubble`，原文仅有一字 OCR 差异（`그럼...` / `그림...`），分别来自相邻图片的跨页结果。
- 根因：全局去重条目只保存基础 `targetKey`。较完整结果淘汰旧结果时，内容脚本据此查询本地结果缓存；实际缓存使用 `targetKey + sourceToken` 的 `scopedTargetKey`，所以旧条目虽从全局去重 Store 删除，旧缓存与旧覆盖层仍留在页面。
- 修复：去重链路完整传递并保存 `scopedTargetKey`；清理被淘汰条目时优先使用该缓存身份，并保留基础 key 作为兼容回退。未调整 OCR 阈值或文本召回规则。
- 回归测试：新增相邻页近似 OCR 文本互相淘汰时的 source-scoped 缓存身份测试，以及内容脚本缓存清理接线测试。
- 本地验证：186 项 Node 测试全部通过；`scripts/build-extension.mjs` 构建成功。
- Chrome 复验：刷新同一 KakaoPage 并重新开启本页翻译后，目标韩文短语仅对应 1 个 `.mt-bubble`，重复覆盖层消失。
- 最终结论：重复翻译来自去重后的缓存清理身份错误，现已修复；无需以增加漏字为代价压制重复。
