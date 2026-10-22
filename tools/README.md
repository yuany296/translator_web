# tools/ 索引

这里放的是**调试与取证工具**，都不注入生产扩展 UI、也不改生产代码。浏览器里的调试页面统一走
本目录 `stage-inspector/serve.mjs` 那个本地服务器打开（原因见下）。

## 可视化页面

| 页面 | 用途 | 启动 |
| --- | --- | --- |
| **阶段检视台** `stage-inspector/index.html` | 逐阶段看一页漫画：检测 → 识别下限 → 结果筛选 → ルビ → 合并 → 区域；可改参数看效果、可看服务端裁剪图（`slice_crops/<stem>-<序号>.png`）、可导出 Markdown 摘要 | `stage-inspector/run_stage_inspector.bat`（或 `node tools/stage-inspector/serve.mjs`），然后 <http://127.0.0.1:8099/stage-inspector/> |
| **Manga OCR Compare Workbench** `ocr-debug-tool/index.html` | 多组 OCR / 过滤参数横向对比，Raw/Filtered/Merged/Overwrite 四视角、导出 | 同上服务器，然后 <http://127.0.0.1:8099/ocr-debug-tool/index.html>；**它的 `serviceUrl` 要填 `http://127.0.0.1:8099`** |
| **背景判定工作台** `ocr-debug-tool/debug_background_workbench.html` | 实底 vs TELEA 清理判定的调参 | 同上服务器，然后 <http://127.0.0.1:8099/ocr-debug-tool/debug_background_workbench.html> |

起过一次服务器后，<http://127.0.0.1:8099/> 就是这三个页面的索引（`serve.mjs` 动态生成）。

> **为什么必须走服务器**：本地 OCR 服务的 CORS 白名单只允许扩展来源
> （`local-ocr-service/ocr_service/dependencies.py` → `^chrome-extension://[a-p]{32}$`）。
> 从 `file://`（`Origin: null`）或 `http://127.0.0.1:8088` 直接 `fetch` OCR 服务会被浏览器拦掉
> ——「Failed to fetch」。`serve.mjs` 用同源反代解决，服务端白名单**不放宽**
> （放开 `null` 等于把本地术语库/译文库暴露给任意网页的 sandbox iframe）。

## 命令行工具

| 文件 | 用途 |
| --- | --- |
| `stage-inspector/stage-core.mjs` | 阶段回放核心 + 一次性静态报告 CLI（跑的是 `dist/test/background.iife.js` 里的真代码） |
| `stage-inspector/serve.mjs` | 本地调试服务器：静态 + 同源反代 + 阶段回放 + 快照/产物 |
| `ocr_debug_common.py` | 调试脚本共用的模型映射与请求封装（**注意**：`get_recognition_model_name` 在这里有第二份，改模型要改两处） |
| `ocr_batch_debug.py` / `ocr_param_sweep.py` / `ocr_compare_params.py` / `bench_ocr_timings.py` | 批量 OCR、参数扫描、对比、计时（会写 `decision.html` 等报告） |
| `debug_paddle_ocr.py` / `check_ocr_env.py` / `create_ocr_fixtures.py` | 单图 OCR、环境自检、测试夹具生成 |
| `run_visual_regression.py` | 视觉回归 |
| `repair_truncated_translations.py` | 修被截断的译文 |
| `cdp.mjs` / `check-novel-quotes.js` / `debug-term-extractor.py` | Chrome DevTools 小工具 / 小说引号检查 / 术语提取调试 |
| `ner-bench.py` | 用人工标注集量**真实链路**（分块 + 阈值 + 后处理 + worker 通信）的 NER 术语提取 P/R/F1；默认读 `AI_work/ner/ko/bench/gold_ko.json`，可传路径覆盖 |

## 相关目录（不在 tools/ 下）

- `.local-data/debug/`：本地 OCR 服务在 `debug:true` 时写的产物 ——
  `plugin_input/<stem>.png`（送进识别器的原图）、`slice_crops/slice-<stem>-NNN.png`（每条检测的裁剪图）、
  `vis/<stem>.jpg`（画了框的可视化）、`result_json/<stem>.json`（完整返回）。**这些就是「阶段检视台」里
  「线上快照」的数据源**，也是判断「识别器到底看到了什么」的第一手证据。
