import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_ROOT = path.join(ROOT, "extension", "src");

// chrome.runtime.* 的别名：它们属于浏览器扩展运行时，不是项目 runtime。
const CHROME_RUNTIME_ALIASES = new Set([
  "connect", "getManifest", "getURL", "onConnect", "onMessage", "openOptionsPage", "reload", "sendMessage"
]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.name.endsWith(".js") ? [absolute] : [];
  });
}

/** 只去掉整行注释与块注释：行内的 // 可能是 URL，不能盲删。 */
function stripComments(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^[ \t]*\/\/.*$/gmu, "");
}

function scanRuntimeUsage() {
  const callSites = new Map();
  const assigned = new Set();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const relative = path.relative(ROOT, file).replaceAll("\\", "/");
    const text = stripComments(readFileSync(file, "utf8"));
    for (const match of text.matchAll(/(?<![\w.$])runtime\.([A-Za-z_$][\w$]*)\s*\(/gu)) {
      if (!callSites.has(match[1])) callSites.set(match[1], new Set());
      callSites.get(match[1]).add(relative);
    }
    // runtime.foo = ... 与 runtime.foo = function ... 都算挂载。
    for (const match of text.matchAll(/(?<![\w.$])runtime\.([A-Za-z_$][\w$]*)\s*=[^=]/gu)) assigned.add(match[1]);
  }
  return { callSites, assigned };
}

// 这一类 bug 的代价很不对称：少挂一个函数不会报错到构建期，只会在渲染时抛
// "runtime.x is not a function"，让整页/整章静默不显示（跨页遮罩就踩过两次）。
test("每个被调用的 runtime 入口都在某处挂载过", () => {
  const { callSites, assigned } = scanRuntimeUsage();
  const missing = [...callSites.entries()]
    .filter(([name]) => !assigned.has(name) && !CHROME_RUNTIME_ALIASES.has(name))
    .map(([name, files]) => `${name} <- ${[...files].sort().join(", ")}`)
    .sort();

  assert.deepEqual(missing, [], `以下 runtime 入口只被调用、没有任何挂载点：\n${missing.join("\n")}`);
});

test("跨页坐标映射与清理入口都已挂载（历史回归）", async () => {
  const { installSceneCrossPage } = await import("../extension/src/content/modules/scene-crosspage.js");
  const { installRendererCrossPage } = await import("../extension/src/content/modules/renderer-crosspage.js");
  const sceneRuntime = { normalizeSeamRect: () => ({ x: 0, y: 0, w: 0, h: 0 }), isValidCrossPageSegment: () => false };
  installSceneCrossPage(sceneRuntime);
  const rendererRuntime = { state: { crossPageOverlaysByRenderKey: new Map() } };
  installRendererCrossPage(rendererRuntime);

  assert.equal(typeof sceneRuntime.mapCompositePointToRoot, "function");
  assert.equal(typeof rendererRuntime.removeCrossPageSurfaceEntry, "function");
});
