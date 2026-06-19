# Manga OCR Compare Workbench

独立 OCR/覆写调试工具，不注入生产扩展 UI。

更新日期：2026-06-18  
执行者：Codex

## 使用

1. 启动本地 OCR 服务：

   ```powershell
   .\start_local_ocr_gpu.bat
   ```

2. 打开调试工具：

   ```powershell
   .\tools\ocr-debug-tool\run_ocr_debug_tool.bat
   ```

3. 使用顶部的 `Add images`、`Add folder`，或直接把单张/多张图片拖入页面；点击缩略图切换当前图片。
4. 默认提供四组匿名参数；直接编辑每组的 `det / box / unclip / rec`，用复选框决定是否参与比较。
5. 点击 `+` 复制最后一组参数，或用 `×` 删除参数组；界面至少保留一组。
6. 点击 `Run pending` 只运行当前图片中新增、修改、失败或尚未运行的参数组；点击 `Run pending for all images` 增量补齐所有图片。
7. 参数组标题栏中的 `↻` 可强制重跑当前图片的单个参数组；该操作不会重跑其他组。
8. 点击包含参数、指标和图片的完整 OCR 结果卡；蓝色外框和 `✓ Selected` 表示它已成为过滤与补漏来源。
9. 选中的 Fast 结果可点击 `Enhance missing`，只添加未被 Fast 覆盖的可靠 Enhanced 候选。
10. 在 OCR 结果下方编辑匿名过滤参数组；每组包含 `confidence / min area / max area / max aspect / merge gap / font scale`。
11. 点击 `Apply filter comparison`，从选中的归一化 OCR 结果生成多列过滤结果；此步骤不会再次请求 OCR 服务。
12. 在效果最好的过滤列点击 `Set best`，再用 `Copy best params` 复制完整的 OCR 与过滤参数。
13. 切换 `Raw / Filtered / Merged / Overwrite` 查看不同阶段；展开 `History, JSON and exports` 可查看历史并导出当前激活列。

## 说明

- 这个工具直接调用 `http://127.0.0.1:8765/ocr`。
- 不会修改扩展 popup、content script 或页面 UI。
- 页面拖放会忽略非图片文件，并沿用文件名、大小和修改时间去重。
- 覆写预览使用模拟译文，重点验证“盖底、字号、换行、溢出、坐标”。
- 参数组不需要命名，自动序号只用于当前界面辨识。
- OCR 参数组和过滤参数组的数值、顺序及启用状态分别保存在浏览器本地；图片和运行结果不会持久化。
- 修改或删除参数组会清除该组已有结果，避免旧画面与新参数不一致。
- 参数组只用于调试请求，不会修改 OCR 服务默认值。
- 页面默认使用 Fast；切换模式、语言或服务地址会清除旧运行结果，避免把不同上下文的结果混在一起。
- 页面处理优先使用服务端归一化后的 `items`；各预处理变体的 `rawItems` 仅保留在高级 JSON 诊断信息中。
- 多组参数依次执行，每组完成后立即显示；单组失败不会中断后续参数。
- OCR 运行采用增量调度，状态为 `done` 的参数组会被跳过；参数修改会使该组在所有已载入图片中重新进入待运行状态。
- 过滤结果按“图片 → OCR 参数组 → 过滤参数组”隔离；切换图片或 OCR 来源不会混用状态。
- 修改过滤参数会清除该过滤组已有结果；重跑或修改 OCR 参数会清除依赖该来源的过滤结果。
- `Set best` 记录当前图片的 OCR 与过滤参数组合。
- `Copy best params` 会复制最佳组合的四个 OCR 参数、六个过滤参数和运行信息。
- `Copy history` 只复制当前图片的调试历史摘要，不会上传或保存到外部服务。
