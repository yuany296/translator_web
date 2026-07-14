# Operations Log

## 2026-07-14 - Codex

- Chrome 复现：开启本页自动翻译且不点击任何译文气泡后，拼接页先生成一个 `mt-seam-window`，随后其内部的 `mt-seam-composite` 又被候选扫描识别为带背景图的普通目标，产生第二套普通覆盖层，造成接缝文本重叠且 OCR 文案略有差异。
- 修复：在统一的 `isSupportedTarget` 入口排除带有或位于 `data-manga-translator-overlay` 内的扩展节点。拼接画布、普通覆盖层、调试节点和后续任何扩展自有背景图均不会重新进入 OCR 队列；单张页面的正常图片逻辑不变。
- 新增回归：`extension-owned seam composites never reenter Kakao OCR target selection`；同时保留 canonical seam 单宿主渲染回归。
- 验证通过：`node --check src/content.js`、`node --check content.js`；3 项内容运行时定向测试通过；`scripts/build-extension.mjs` 通过并更新 `dist/`。
- 全量 `node --test` 仍有既有失败：内容运行时测试引用未暴露的旧辅助 API，以及 5 个 Kakao pipeline 的 250ms 超时用例；与本次目标过滤修改无关。Chrome 自动化无法进入 `edge://extensions` 重载本地扩展，需在扩展管理页手动点击“重新加载”后再刷新阅读页验证。

## 2026-07-14 - Codex

- 定位 Kakao 拼接处重复渲染：旧的独立跨页 overlay 与 canonical seam surface 同时输出。
- 将拼接结果统一保留在 canonical `renderOverlay` 渲染链路；禁用旧的独立跨页渲染入口。
- 验证：`src/content.js`、`src/kakao-pipeline.js` 语法检查通过；新增拼接渲染回归用例通过。
- 定向回归全部通过；全量历史测试仍有既有的运行时辅助 API 缺失与 250ms 超时问题，与本次修改无关。

## 2026-07-14 — Codex

- 检查 `C:\Users\yuanying\.codex\logs_2.sqlite`：数据库处于 WAL 模式；`logs` 表约 13.9 万条记录，其中 TRACE 约 9.6 万条，3 秒采样期间 `MAX(id)` 增长且 TRACE 持续写入，确认存在高频 TRACE 写盘。
- 在 `logs` 表创建 `logs_ignore_trace_insert` trigger：对 `NEW.level = 'TRACE'` 的 INSERT 使用 `RAISE(IGNORE)` 拦截。
- 验证：trigger 生效后 5 秒内 TRACE 最大 ID 保持 `65866549`，TRACE 条数未增长；`MAX(id)` 仅由非 TRACE 日志增加 2；WAL 文件保持约 9.55 MB。
