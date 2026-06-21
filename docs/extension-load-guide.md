# 漫画图片翻译扩展加载指南

日期：2026-06-21
执行者：Codex

## 唯一源码与加载目录

扩展只保留根目录实现，正式源码为：

- `manifest.json`
- `background.js`
- `content.js`
- `popup.html` / `popup.js`
- `styles.css`

Chrome / Edge 开发调试时直接加载仓库根目录：
`C:\homework\AI_work\translator`。

## 可选打包

```powershell
npm run build
```

构建不再编译另一套源码，只校验根目录 JavaScript 和 manifest，然后将同一套文件复制到 `dist/`。`dist/` 可用于分发，但日常开发应加载根目录，避免忘记重新构建。

## Chrome / Edge 加载

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 启用“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `C:\homework\AI_work\translator`。

## 第一阶段验收

- popup 能打开并保存设置。
- “扫描图片”能返回候选图片数量。
- 开启“调试框”并保存后，网页上出现候选图片绿色框。
- “清缓存”能清理 `chrome.storage.local` 中的翻译缓存。

## 验证命令

```powershell
npm test
npm run build
```

真实翻译调用仍需要配置本地/百度 OCR 与 OpenAI-compatible 翻译服务。
