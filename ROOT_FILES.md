# 根目录文件说明

根目录的文件是 `src/` 的运行时副本，供 Chrome/Edge 加载。

## 开发工作流

1. 在 `src/` 中编辑源文件
2. 运行 `npm run dev` 同步到根目录
3. 在 `chrome://extensions` 中点重新加载扩展
4. 测试改动

## 构建

`npm run build` 从 `src/` 读取，语法检查后输出到 `dist/`。

## 文件清单

| 根目录文件 | 源码位置 | 说明 |
|---|---|---|
| `background.js` | `src/background.js` | Service Worker |
| `content.js` | `src/content.js` | Content Script |
| `kakao-pipeline.js` | `src/kakao-pipeline.js` | KakaoPage 管线 |
| `kakao-reconciler.js` | `src/kakao-reconciler.js` | KakaoPage 调解器 |
| `glossary-core.js` | `src/glossary-core.js` | 术语核心逻辑 |
| `glossary.js` | `src/glossary.js` | 术语管理 UI |
| `glossary.html` | `src/glossary.html` | 术语管理页面 |
| `term-discovery-core.js` | `src/term-discovery-core.js` | 术语发现核心 |
| `popup.js` | `src/popup.js` | 弹窗逻辑 |
| `popup.html` | `src/popup.html` | 弹窗页面 |
| `styles.css` | `src/styles.css` | 覆盖层样式 |
| `manifest.json` | `src/manifest.json` | 扩展清单 |
