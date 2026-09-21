# CLAUDE.md — Manga Realtime Translator

## Build & Verify

```bash
npm run build          # esbuild: extension/src → dist/extension
npm run dev            # watch mode
npm run verify         # line gate + lint (JS+Python) + build + tests
npm run check:lines    # production 400, entrypoints 120, tests 800
npm run lint:js        # ESLint (extension/src)
npm run lint:python    # Pylint (local-ocr-service)
npm run test:node      # Node test suite (955 tests)
npm run test:python    # Python test suite (102 tests)
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
- Three LLM services (translation / chapter term extraction / sentence-level extraction) share one named config library (`mt_translation_vendors_v1`, managed in Settings → 翻译服务). Extraction sections store `{ vendor, followTranslation }` — `vendor` names a library entry, `followTranslation` only keeps legacy saves working; `runtime.termDiscoveryEnabled` / `runtime.sentenceExtractionEnabled` are the two per-service switches; `resolveExtractionConfig()` resolves a section to effective provider/baseUrl/model/apiKey
- `shared/glossary.js`: glossary schema v4 — `{ libraries: [{ id, name, enabled, urls }], entries: [{ libraryId, scope, scopeKey, … }] }`. A library switch gates its whole entry set out of prompts/fingerprints; `urls` only routes newly discovered terms (longest-prefix path match, enabled libraries only). Entry-level `enabled` stays independent. Fingerprint prefix is `g4-`.
- SQLite glossary schema v5: `glossary_libraries` table + `library_id` on `glossary_entries`/`pending_candidates`; identity index is `(source_key, src_lng, tgt_lng, scope_type, scope_key, library_id)`

## Module Layout

### Background (`extension/src/background/modules/`) — 30 files
`messages.js`, `term-discovery.js`, `term-discovery-messages.js`, `term-discovery-extract.js`, `ocr-pipeline.js`, `ocr-dispatch.js`, `observation-results.js`, `seam-handling.js`, `capture.js`, `ocr-provider.js`, `vision-ocr.js`, `ocr-clustering.js`, `ocr-styles.js`, `ocr-lines.js`, `ocr-regions.js`, `ocr-cluster-geometry.js`, `ocr-display-geometry.js`, `ocr-item-filter.js`, `ocr-candidates.js`, `baidu-provider.js`, `baidu-results.js`, `translation-provider.js`, `translation-helpers.js`, `translation-coalesce.js`, `translation-utils.js`, `platform-cache.js`, `platform-settings.js`, `platform-storage.js`, `background-state.js`, `bootstrap.js`

### Content (`extension/src/content/modules/`) — 31 files
`reader-init.js`, `reader-observers.js`, `reader-state.js`, `reader-api.js`, `reader-startup.js`, `scheduler.js`, `recognition-workflow.js`, `recognition-payload.js`, `recognition-binding.js`, `recognition-seam.js`, `recognition-stitch.js`, `recognition-overlap.js`, `capture-payload.js`, `scene-projection.js`, `scene-crosspage.js`, `scene-dispatch.js`, `renderer-overlay.js`, `renderer-embed.js`, `renderer-canvas.js`, `lifecycle-bubble.js`, `lifecycle-position.js`, `lifecycle-font-fit.js`, `lifecycle-restore.js`, `controls-ui.js`, `controls-autotranslate.js`, `controls-utils.js`, `target-filter.js`, `target-resolve.js`, `target-cache.js`, `platform-runtime.js`, `platform-dom.js`

### Canonical — modules/ (17 files) + sub-directories
- `modules/`: `stitch-geometry.js` ~ `pipeline-api.js`
- `reconciler-modules/`: `reconciler-observation.js` ~ `reconciler-startup.js`
- `pipeline-factory/`, `canonical-pipeline-factory/`, `page-store-factory/`

### Glossary — 11 files
`glossary-editor.js` (boot/tabs/pending rendering), `glossary-pending.js` (pending actions + local load), `glossary-terms-view.js` (official table, term dialog), `glossary-batch-actions.js` (multi-select, batch move/delete), `glossary-storage.js` (server sync, persistEntries), `glossary-transfer.js` (import/export/clear), `glossary-library-store.js` (library CRUD + server push), `glossary-library-panel.js` (switches, bound-URL editor, chapter routing control), `novel-memory-editor.js`, `glossary-import-target.js` (import target routing)

### Shared glossary/term-discovery modules (`extension/src/shared/`)
`glossary.js` (schema v4 + effective entry resolution), `glossary-library.js` (library normalization + URL prefix matching), `term-discovery.js` (merge/orchestration), `term-discovery-keys.js` (chapter/source identity helpers), `term-discovery-pending.js` (pending store + chapter `libraryId`), `term-discovery-ignored.js` (ignored store)

## Code Patterns

- Entry points (`*/index.js`) wire modules via installers — no business logic
- `configure.js` files bind providers, config stores, and message handlers
- Test files use `runtime` objects with test hooks replacing real API calls
- OCR cache: image + OCR config + geometry version. Translation cache: canonical text + translation config + prompt version + glossary fingerprint
- Rename scripts (`scripts/rename-modules.mjs`, `scripts/rename-subdirs.mjs`, `scripts/merge-small-files.mjs`) are one-time migration tools documenting the 2026-07-16 reorganization
