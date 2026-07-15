# CLAUDE.md — Manga Realtime Translator

## Build & Verify

```bash
npm run build          # esbuild: extension/src → dist/extension
npm run dev            # watch mode
npm run verify         # line gate + lint (JS+Python) + build + tests
npm run check:lines    # production 400, entrypoints 120, tests 800
npm run lint:js        # ESLint (extension/src)
npm run lint:python    # Pylint (local-ocr-service)
npm run test:node      # Node test suite (464 tests)
npm run test:python    # Python test suite (58 tests)
```

## Architecture

```
Reader Profile → Detect → Crop OCR → Observation → Canonical → Translation → Crop-local Layout → RenderScene → Renderer
```

- **extension/src/**: ESM source organized by domain (background, content, canonical, config, geometry, glossary, layout, popup, readers, recognition, rendering, shared)
- **extension/public/**: Static assets (manifest.json, popup.html, glossary.html, styles.css)
- **dist/extension/**: Build output loaded by Chrome
- **local-ocr-service/**: Python PaddleOCR service (`ocr_service/` package + `server.py`)
- **Module pattern**: Domain-named sub-modules (e.g., background `messages.js`, content `reader-init.js`, canonical `stitch-geometry.js`) install functions onto a shared `runtime` object via `install*()` functions. Sub-directories preserved for reconciler, pipeline-factory, canonical-pipeline-factory, page-store-factory
- **Provider registry**: `background/providers/registry.js` — OCR and translation providers registered with contract validation

## Key Contracts

- `recognition/contracts.js`: Immutable `DetectedTextRegion` (geometry) and `RecognizedTextRegion` (text only, no geometry mutation)
- `layout/placement.js`: `buildPlacementGeometry()` — angled placement using axis/normal decomposition
- `layout/crop-local-layout.js`: `layoutInPlacement()` — text fitting in crop-local coordinates
- `rendering/render-scene.js`: `RenderScene` with `cover`/`text`/`debug`/`loading` layers
- `geometry/transforms.js`: Homography round-trip validation
- `config/schema.js`: Three independent config keys (`mt_ocr_config_v1`, `mt_translation_config_v1`, `mt_runtime_config_v1`)

## Module Layout

### Background (`extension/src/background/modules/`) — 28 files
`messages.js`, `term-discovery.js`, `ocr-pipeline.js`, `ocr-dispatch.js`, `observation-results.js`, `seam-handling.js`, `capture.js`, `ocr-provider.js`, `vision-ocr.js`, `ocr-clustering.js`, `ocr-styles.js`, `ocr-lines.js`, `ocr-regions.js`, `ocr-cluster-geometry.js`, `ocr-display-geometry.js`, `ocr-item-filter.js`, `ocr-candidates.js`, `baidu-provider.js`, `baidu-results.js`, `translation-provider.js`, `translation-helpers.js`, `translation-coalesce.js`, `translation-utils.js`, `platform-cache.js`, `platform-settings.js`, `platform-storage.js`, `background-state.js`, `bootstrap.js`

### Content (`extension/src/content/modules/`) — 31 files
`reader-init.js`, `reader-observers.js`, `reader-state.js`, `reader-api.js`, `reader-startup.js`, `scheduler.js`, `recognition-workflow.js`, `recognition-payload.js`, `recognition-binding.js`, `recognition-seam.js`, `recognition-stitch.js`, `recognition-overlap.js`, `capture-payload.js`, `scene-projection.js`, `scene-crosspage.js`, `scene-dispatch.js`, `renderer-overlay.js`, `renderer-embed.js`, `renderer-canvas.js`, `lifecycle-bubble.js`, `lifecycle-position.js`, `lifecycle-font-fit.js`, `lifecycle-restore.js`, `controls-ui.js`, `controls-autotranslate.js`, `controls-utils.js`, `target-filter.js`, `target-resolve.js`, `target-cache.js`, `platform-runtime.js`, `platform-dom.js`

### Canonical — modules/ (17 files) + sub-directories
- `modules/`: `stitch-geometry.js` ~ `pipeline-api.js`
- `reconciler-modules/`: `reconciler-observation.js` ~ `reconciler-startup.js`
- `pipeline-factory/`, `canonical-pipeline-factory/`, `page-store-factory/`

### Glossary — 3 files
`glossary-editor.js`, `glossary-pending.js`, `glossary-storage.js`

## Code Patterns

- Entry points (`*/index.js`) wire modules via installers — no business logic
- `configure.js` files bind providers, config stores, and message handlers
- Test files use `runtime` objects with test hooks replacing real API calls
- OCR cache: image + OCR config + geometry version. Translation cache: canonical text + translation config + prompt version + glossary fingerprint
- Rename scripts (`scripts/rename-modules.mjs`, `scripts/rename-subdirs.mjs`, `scripts/merge-small-files.mjs`) are one-time migration tools documenting the 2026-07-16 reorganization
