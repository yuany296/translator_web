# 根目录唯一实现验证记录

日期：2026-06-21
执行者：Codex

## 变更范围

- 删除 `src/` 下的第二套 TypeScript/React 扩展实现。
- 删除 Vite、Vitest、TypeScript 配置与依赖。
- 构建流程改为校验根目录 JavaScript/manifest，并复制根目录扩展文件到 `dist/`。
- 加载指南统一要求开发时直接加载仓库根目录。

## 验证结果

- `npm.cmd test`：19 passed。
- `node --test tests/background_runtime.test.mjs tests/overlay_style.test.mjs`：11 passed。
- `npm.cmd run build`：通过。
- `manifest.json`、`background.js`、`content.js`、`popup.html`、`popup.js`、`styles.css` 与 `dist/` 对应文件 SHA-256 全部一致。
- `dist/manifest.json` 确认入口为 `background.js`、`content.js`、`styles.css`。

## 说明

本次只统一源码、构建和加载入口，没有修改 OCR、翻译或覆盖层业务逻辑。
