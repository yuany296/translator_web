/**
 * Central configuration for the three floating action icons.
 *
 * Icons are user-provided bitmaps (kept under extension/public/assets/floating-actions/)
 * and are referenced from a single place instead of being scattered across components.
 * Swap the paths here to replace icons with official SVG assets.
 *
 * The module is pure (no chrome API calls at module scope) so it can be unit tested
 * in Node; resolveFloatingActionIcon wires the real chrome.runtime.getURL at use time.
 */

const FLOATING_ACTION_ICON_PATHS = Object.freeze({
  novel: "assets/floating-actions/小说翻译_圆形图标.png",
  comic: "assets/floating-actions/漫画翻译_圆形图标.png",
  webpage: "assets/floating-actions/网页翻译_圆形图标.png"
});

const FLOATING_ACTION_IDS = Object.freeze(["novel", "comic", "webpage"]);

function resolveFloatingActionIcon(actionId, urlResolver = null) {
  const relative = FLOATING_ACTION_ICON_PATHS[actionId];
  if (!relative) return "";
  const resolver = urlResolver || (typeof globalThis.chrome?.runtime?.getURL === "function"
    ? globalThis.chrome.runtime.getURL.bind(globalThis.chrome.runtime)
    : null);
  return resolver ? resolver(relative) : relative;
}

export default Object.freeze({
  FLOATING_ACTION_ICON_PATHS,
  FLOATING_ACTION_IDS,
  resolveFloatingActionIcon
});
