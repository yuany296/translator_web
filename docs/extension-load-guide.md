# 漫画图片翻译扩展加载指南

日期：2026-06-06  
执行者：Codex

## 运行与打包

```powershell
npm install
npm run build
```

构建产物位于 `dist/`。Chrome / Edge 加载扩展时请选择 `dist` 目录，而不是仓库根目录。

## Chrome / Edge 加载

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 启用“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `C:\homework\AI_work\translator\dist`。

## 第一阶段验收

- popup 能打开并保存设置。
- “扫描图片”能返回候选图片数量。
- 开启“调试框”并保存后，网页上出现候选图片绿色框。
- “清缓存”能清理 `chrome.storage.local` 中的翻译缓存。

## 后续功能说明

当前 TypeScript 架构已经固定 OCR Provider、Translator Provider、文本块合并、Overlay/Embedded Renderer 的模块边界。真实翻译调用需要配置百度 OCR 与 OpenAI-compatible 或自定义 HTTP 翻译服务。
