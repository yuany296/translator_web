# Mobile Userscript (No Backend)

## Files
- `manga-translator-mobile.user.js`: Tampermonkey/Userscript main script.

## What It Does
- Detects manga targets (`img`, `canvas`) with `MutationObserver + IntersectionObserver`.
- Supports automatic trigger and manual trigger (floating button `译`).
- Calls vision model APIs directly from the script (no backend):
  - `anthropic`
  - `openai_compatible`
- Renders translated bubbles on top of the image/canvas.
- Click bubble to toggle translated/original text.

## Install (Android)
1. Install a browser/userscript environment that supports `GM_xmlhttpRequest`.
2. Install this script file: `manga-translator-mobile.user.js`.
3. Open script menu and click `配置 API`.
4. Fill provider/model/apiKey/baseUrl.

## Menu Commands
- `配置 API`
- `手动翻译当前视口`
- `开关自动翻译`
- `开关悬浮球`

## Notes
- No backend required.
- API keys are stored in userscript storage (`GM_setValue`).
- First translation can be slower due to OCR+vision model latency.

## Quick Test (cmoa)
- Open speedreader page.
- Tap floating `译` button.
- You should see `OCR + 翻译中...` then translated overlays.
