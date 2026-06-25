# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Manifest V3 Chrome/Edge extension that detects manga `img`/`canvas` elements on any page, calls vision LLMs for OCR + translation, and renders Simplified Chinese translations over the original text. Two render modes: CSS overlay bubbles (clickable to toggle source/translated), and embedded in-painting (text drawn into the image).

## Commands

```bash
# Run all tests (Node.js built-in test runner)
npm test

# Syntax-check all JS files (also done during build)
node --check background.js && node --check content.js && node --check popup.js

# Build (copies source files to dist/, validates JSON/manifest and JS syntax first)
npm run build
```

## Architecture

Three main JS files form the extension, plus supplementary systems:

### `background.js` — Service Worker
- All API calls to vision models (Anthropic, OpenAI-compatible, Baidu OCR, local PaddleOCR) originate here.
- Handles image fetching (cross-origin safe via `fetch`), data URL conversion, JPEG transcoding on format errors.
- Contains OCR post-processing pipeline: coordinate normalization (`[0,1]` → `[0,100]`), deduplication, solid/transparent background classification, same-line merging, paragraph clustering, Kakao page stitching, block-level translation caching via `chrome.storage.local`.
- Key exports for testing: `buildLocalPaddleBubbleItems`, `clusterLocalPaddleWords`, `shouldMergeLocalPaddleSameLine`, `shouldMergeLocalPaddleParagraphLines`, `collapseDuplicateLocalPaddleTranslations`, `mergeOcrCandidateGroup`, `buildLocalSolidPaintBox`, `normalizeBaiduOcrItem`, `setCache`, `isTranslationCacheKey`, etc.

### `content.js` — Content Script (IIFE, runs on all frames)
- Single-instance via `globalThis.__MANGA_TRANSLATOR_V3__` guard; handles extension hot-reload invalidation.
- `MutationObserver` + `IntersectionObserver` detect manga targets entering viewport.
- Site-specific handling for Pixiv Comic Viewer, KakaoPage (strip stitching across page boundaries), and CMOA speed reader.
- Rendering: positions overlay `<div>` per bubble by percentage coordinates relative to target rect. On scroll/resize, repositions overlays without re-computing text layout.
- Embedded mode: composites translated text onto new canvas/image and swaps `src`.
- Pretranslation pipeline: "ahead" mode (current + next N images) and "continuous" mode (all pending from current position).
- Key exports for testing: `isVerifiedKakaoStitchNeighbor`, `buildKakaoStitchWindowPlan`, `mapKakaoStitchedResult`, `dedupeKakaoResultByPageCoordinates`, `buildSolidBackgroundBox`, `normalizeBubbleRotation`, `getBubbleRenderColors`, `formatTranslationForOriginalLines`.

### `popup.js` + `popup.html` — Extension Popup
- Settings UI: provider/model/apiKey/baseUrl/baidu/localOcr fields, capture mode, render mode, pretranslate mode, and advanced OCR params.
- Saves to `chrome.storage.local`, communicates state to content script via messaging.

### `styles.css` — Overlay Styles
- CSS for overlay layer, bubble text, debug boxes (raw/duplicate/deduped/block classifications), loading indicators, and source-text toggle (`mt-show-source` hides translation).

### `local-ocr-service/` — Python PaddleOCR Server
- FastAPI server at `http://127.0.0.1:8765` with `/ocr` and `/health` endpoints.
- Used by the `local_paddle_deepseek` provider; OCR runs locally, only translation goes to the LLM API.
- Supports fast (original image only) and enhanced (gray/inverted variants) modes.

### `tools/ocr-debug-tool/` — OCR Parameter Tuning Workbench
- Standalone HTML tools for comparing OCR parameters and background classification settings without modifying production code.
- `index.html`: multi-parameter OCR comparison. `debug_background_workbench.html`: solid vs. complex background classification tuning.

### `mobile-userscript/` — Tampermonkey Variant
- Self-contained userscript version that calls vision APIs directly (no service worker). Supports `anthropic` and `openai_compatible` providers.

### `tests/` — Test Suite
- `background_runtime.test.mjs`: Unit tests for background.js OCR processing — cache management, stitching, deduplication, paragraph merging, solid paint boxes.
- `content_runtime.test.mjs`: Unit tests for content.js — Kakao stitching geometry, coordinate remapping, overlay positioning, pretranslation scheduling, debug overlay exposure.
- `overlay_style.test.mjs`: CSS regression tests verifying overlay hide/show rules, bubble positioning, and debug box isolation.
- `test_ocr_debug.py` / `test_visual_baseline.py` / `test_background_debug.py`: Python tests for OCR processing and visual regression.
- Tests use Node.js built-in `node:test` + `node:assert` (no Jest/Vitest). Background tests load `background.js` into a `vm` sandbox with stubbed `chrome.*` APIs.

### `scripts/build-extension.mjs` — Build
- Validates `manifest.json`, syntax-checks all JS files, then copies the 6 extension files to `dist/`.

## Provider Modes

| Provider | OCR | Translation |
|---|---|---|
| `anthropic` | Claude Vision | Claude (same call) |
| `openai_compatible` | Vision-compatible model | Same model (same call) |
| `baidu_deepseek` | Baidu OCR API | OpenAI-compatible Chat API |
| `local_paddle_deepseek` | Local PaddleOCR server | OpenAI-compatible Chat API |

## Cache Architecture

- `chrome.storage.local` caches translation results keyed by `mt_cache_v4:<sourceImageId>:<normalizedTextHash>`.
- Quota errors trigger automatic eviction of old cache entries (v2, then v3, then oldest v4).
- Cached results strip large payloads (`cleanedImage`, `debug`) but preserve a `requiresCleanedImage` flag for complex backgrounds.
- Per-page payload cache (`PAYLOAD_CACHE_TTL_MS` = 90s) avoids re-fetching image data URLs.

## Coordinate System

Bubble coordinates are always normalized to `[0, 100]` percentage of the source image dimensions. Models returning `[0, 1]` are auto-scaled. The content script converts percentages to absolute CSS positions based on the target element's bounding rect. Stitched Kakao results remap from composite coordinates back into per-image space.

## Key Constants

All tunable thresholds are defined at the top of `content.js` and `background.js` — image max side, JPEG quality, bubble font sizing, observer root margins, parallel translation limits, and cache sizes. OCR filtering thresholds (confidence, min/max box area, aspect ratio, merge gap) are user-configurable via storage but have defaults in `background.js` `DEFAULT_SETTINGS`.

## Issue Tracking

See [`problems.md`](problems.md) for the known-issues registry with root cause analysis, fix points, and resolution status. When a Chrome/Edge real-page test reveals a new regression, add it as a new section to `problems.md` with symptoms, root cause, fix description, and status. Mark as ✅ resolved once the fix is committed and verified.

## Dev Workflow

当修复 Bug 或做优化时，按以下循环：

1. **`npm test`** — 先确保现有测试通过
2. **`npm run build`** — 构建到 dist/
3. **Chrome 连接测试** — 打开 `chrome://extensions` 点重新加载，然后在真实页面观察行为
4. **`node --check content.js && node --check background.js`** — 改完后语法检查
5. **问题诊断** — 打开 DevTools 控制台看错误日志；检查 DOM 中 `.mt-overlay-root` 的状态（加载中/已渲染/卡住）
6. **记录到 `problems.md`** — 新问题加上症状、根因、修复方案，解决了标记 ✅
7. **提交** — 测试通过后 `git add` + `git commit`
