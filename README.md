# Manga OCR Translator · Next (MV3)

A Chrome/Edge extension that detects manga `img/canvas` on supported sites, performs OCR + translation, and overlays or embeds translated text in place.

## Architecture

```
Reader Profile → Detect → Crop OCR → Observation → Canonical → Translation → Crop-local Layout → RenderScene → Renderer
```

- **OCR** and **translation** are independently configured, executed, and cached.
- Original crop geometry is immutable authoritative data; translations may not expand overlay regions.
- Source code is organized under `extension/src/` with single-file 400-line limits.

## Directory Structure

```
translator/
├── extension/
│   ├── src/                   # ESM source (background, content, popup, …)
│   │   ├── background/        # Service worker: message routing, OCR/translation providers, cache
│   │   ├── canonical/         # Canonical pipeline, reconciler, page store, projection
│   │   ├── config/            # Configuration schema & store (OCR / translation / runtime / extractions)
│   │   ├── content/           # Content script: reader runtime, scheduler, capture, scene, renderer
│   │   ├── geometry/          # Homography & transform helpers
│   │   ├── glossary/          # Glossary management UI
│   │   ├── layout/            # Crop-local layout & placement geometry
│   │   ├── novel-mobile/      # Novel-mode mobile build (separate bundle + manifest)
│   │   ├── popup/             # Popup UI controller
│   │   ├── quick-popup/       # In-page quick settings popup
│   │   ├── readers/           # Reader profile detection & site hints (KakaoPage, RIDI, Pixiv, CMOA)
│   │   ├── recognition/       # Geometry contracts (DetectedTextRegion, RecognizedTextRegion, etc.)
│   │   ├── rendering/         # RenderScene, DOM renderer, embedded (canvas) renderer
│   │   ├── settings/          # Options page (services, vendors, local service reachability)
│   │   ├── shared/            # Shared utilities, glossary core, term discovery core, hashes, constants
│   │   ├── sidepanel/         # Chapter-revision side panel
│   │   └── translations/      # Official translation library UI
│   └── public/                # Static assets: manifest.json, HTML, CSS
├── dist/extension/            # Build output — loaded by Chrome
├── dist/novel-mobile/         # Mobile novel-mode build output (separate manifest)
├── local-ocr-service/         # Python PaddleOCR service + glossary store
│   ├── glossary_store/        # SQLite glossary (schema v6)
│   ├── translation_store/     # SQLite official translation library (schema v5)
│   └── ocr_service/pipeline/  # Detect/Crop/Recognize/Appearance orchestration
├── scripts/                   # Build, test runners, linting, line-length gate
├── tests/                     # Node & Python tests
└── .local-data/               # Runtime data (git-ignored)
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start the local OCR service (optional)

See `local-ocr-service/README.md`. When running locally, the OCR service handles text detection, crop, recognition, and cleaned-image generation.

### 3. Build the extension

```bash
npm run build       # one-shot build to dist/extension/
npm run dev         # watch mode
```

### 4. Load in Chrome

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/extension/` directory

## Configuration

The popup has three independent configuration cards that save separately:

### OCR

- **Provider**: `baidu` (Baidu cloud OCR) or `local_paddle` (local PaddleOCR service)
- Baidu: API Key + Secret Key
- Local Paddle: service URL, language (`auto`/`japan`/`korean`), mode (`fast`/`enhanced`)
- Tuning: confidence threshold, min/max box area, aspect ratio, line merging
- Vision Repair (optional): low-confidence crop repair via vision model (Qwen VL OCR, GPT-4o, etc.)

### Translation

- **Provider**: `openai_compatible`
- Model, API Key, Base URL (e.g., `https://api.deepseek.com` for DeepSeek)
- Named profiles live in Settings → 翻译服务 and are shared by all three LLM services (translation, chapter term extraction, sentence-level extraction): each row picks one profile from the same library, and the two extraction rows have their own enable switch
- Legacy saves are migrated automatically: an old "follow translation service" setting is pinned to the active profile, and an extraction-only Base URL / Model / Key becomes its own named profile
- Local or self-hosted OpenAI-compatible services (Ollama `http://127.0.0.1:11434/v1`, custom proxies) need **no** API Key — the key is only required for providers that need one (OpenAI, Qwen, GLM, DeepSeek, Kimi, SiliconFlow, 火山方舟)

### Runtime

- Enable/disable, floating ball, capture mode (direct/screenshot), render mode (overlay/embedded)
- Pre-translate mode: manual / ahead / continuous
- Debug overlay, term discovery, font scale, cover padding

## Translation Pipeline

1. **OCR_DATA_URL** — detect & recognize text regions
2. **Canonical reconciliation** — match observations across pages/seams
3. **TRANSLATE_TEXT_BLOCKS** — batch translate canonical text blocks

OCR and translation use separate caches. Changing translation config does not re-trigger OCR. If OCR succeeds but translation fails, retries only re-execute translation.

## Provider Interfaces

### OCR Provider

```
normalizeConfig → validate → checkHealth → recognize
```

### Translation Provider

```
normalizeConfig → validate → checkHealth → translateBatch → fingerprint
```

## Glossary

- Glossary entries map source→target and are injected into translation prompts. Entries live in named
  **libraries** (max 50) and are scoped per-work or globally; a library switch gates its whole entry set
  out of prompts, and a library's "apply URLs" gate which pages it applies to.
- Managed via the glossary page (`chrome://extensions` → Options → 术语表)
- Term discovery: automatic extraction of Korean/English proper nouns from OCR results
- Max 500 entries **per library**; import accepts JSON, CSV, or a SQLite glossary `.db/.sqlite`; export is JSON or CSV

## Verification

```bash
npm run verify          # Full pipeline: line gate + lint + build + tests
npm run check:lines     # File length gate (production 400, entrypoints 120, tests 800)
npm run lint:js         # ESLint
npm run lint:python     # Pylint
npm run test:node       # Node.js test suite
npm run test:python     # Python test suite
```

## Key Design Decisions

- **Immutable crop geometry**: `DetectedTextRegion` contains source polygon, crop transform, and line thickness. `RecognizedTextRegion` only adds text/confidence — it never rewrites geometry. (These frozen constructors live in `recognition/contracts.js` and are currently exercised by the contract test only; the shipped pipeline assembles its geometry in `rendering/scene-builder.js`.)
- **OCR grouping**: `SemanticTextBlock` references `memberRegionIds` only. Grouped axis-aligned boxes must not overwrite original polygons.
- **Placement**: Translation text is measured and wrapped in crop-local coordinates, then mapped back through the saved crop→source homography.
- **Italic handling**: Layout width uses text axis length, height uses normal thickness. `fontHeight` uses the median member `lineThickness` as the cap.
- **Overflow**: `expandBubbleForTextOverflow` still exists (`content/modules/lifecycle-font-fit.js`) and is used
  when fitting text — but its "expansion" is bounded by the bubble: translation length never changes placement
  geometry, overlays must not exceed reliable bubble bounds or crop union, and unfit text is marked
  `layout_unfit` while the original text is preserved.
- **RenderScene**: Unified scene model with `page`/`composite` surfaces and `cover`/`text`/`debug`/`loading` layers. DOM and embedded (canvas) renderers consume the same placement geometry and font size.
- **Reader profiles**: Auto-detected (`independent-media`, `continuous-strip`, `virtualized-strip`, `canvas-reader`). KakaoPage, RIDI, Pixiv, CMOA provide site hints for profile weighting and selectors; RIDI also runs in novel mode (same host list as the reader detection, see `shared/novel-hosts.js`).

## Debugging

- Content script logs: Page DevTools Console, filter `MangaTranslator`
- Background logs: Extensions → Service Worker → Inspect
- Debug overlay modes: `raw`, `filtered`, `merged`, `final`
