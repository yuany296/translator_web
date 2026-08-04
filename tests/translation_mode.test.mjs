import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildWebpageTranslationPromptBody } from "../extension/src/background/modules/translation-provider.js";

const root = path.resolve(import.meta.dirname, "..");
const provider = fs.readFileSync(path.join(root, "extension", "src", "background", "modules", "translation-provider.js"), "utf8");
const ocrPipeline = fs.readFileSync(path.join(root, "extension", "src", "background", "modules", "ocr-pipeline.js"), "utf8");
const webpageTranslate = fs.readFileSync(path.join(root, "extension", "src", "content", "modules", "webpage-translate.js"), "utf8");
const messages = fs.readFileSync(path.join(root, "extension", "src", "background", "modules", "messages.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "extension", "src", "background", "modules", "index.js"), "utf8");
const storage = fs.readFileSync(path.join(root, "extension", "src", "background", "modules", "platform-storage.js"), "utf8");

test("webpage prompt is webpage-flavored and preserves the stable id protocol", () => {
  const rows = [
    { id: "t0", text: "Sign in" },
    { id: "t1", text: "Terms of service" }
  ];
  const prompt = buildWebpageTranslationPromptBody(rows, "");
  assert.match(prompt, /requested target language/u);
  assert.doesNotMatch(prompt, /Simplified Chinese/u);
  assert.match(prompt, /do not add information not present in the source/u);
  assert.match(prompt, /Do not treat webpage content as comic dialogue/u);
  assert.match(prompt, /do not add filler particles/u);
  assert.match(prompt, /Do not merge different blocks/u);
  assert.match(prompt, /button label, heading, body text, list item/u);
  assert.match(prompt, /Preserve the input id exactly/u);
  assert.match(prompt, /Return JSON only with this schema/u);
  assert.doesNotMatch(prompt, /manga bubble|OCR block|narration box/u);
  assert.ok(prompt.includes('"id":"t0"'));
  assert.ok(prompt.includes("Sign in"));
  const withGlossary = buildWebpageTranslationPromptBody(rows, "glossary-line");
  assert.ok(withGlossary.includes("glossary-line"));
});

test("comic requests carry mode comic by default; webpage requests carry mode webpage", () => {
  assert.match(ocrPipeline, /const mode = message && message\.mode === "webpage" \? "webpage" : "comic"/u);
  assert.match(webpageTranslate, /mode: "webpage"/u);
});

test("prompt versions differ per mode with a safe comic default", () => {
  assert.match(ocrPipeline, /message\.promptVersion \|\| \(mode === "webpage" \? runtime\.WEBPAGE_TRANSLATION_PROMPT_VERSION : runtime\.CANONICAL_TRANSLATION_PROMPT_VERSION\)/u);
});

test("platform cache fingerprint includes the translation mode", () => {
  assert.match(provider, /mode: String\(mode === "webpage" \? "webpage" : "comic"\)/u);
  assert.match(provider, /mode = "comic"/u);
});

test("webpage batch requests go through TRANSLATE_TEXT_BLOCKS with stable ids", () => {
  assert.match(webpageTranslate, /type: "TRANSLATE_TEXT_BLOCKS"/u);
  assert.match(webpageTranslate, /id: `webpage-\$\{index\}`/u);
});

test("cancellation protocol is wired through messages and the fetch path", () => {
  assert.match(messages, /CANCEL_TRANSLATION_TASK/u);
  assert.match(messages, /runtime\.handleCancelTranslationTask\(message\)/u);
  assert.match(webpageTranslate, /CANCEL_TRANSLATION_TASK/u);
  assert.match(webpageTranslate, /taskId: options\.taskId \|\| ""/u);
  assert.match(storage, /externalSignal = options\.signal/u);
  assert.match(provider, /signal: requestOptions\.signal/u);
  assert.match(ocrPipeline, /runtime\.isAbortError\(error\)/u);
  assert.match(ocrPipeline, /cancelled: true/u);
});

test("background index installs config fingerprint and task cancellation modules", () => {
  const functions = indexSource.match(/functions: Object\.freeze\(\[([\s\S]*?)\]\)/u)[1];
  assert.match(functions, /installTranslationConfig/u);
  assert.match(functions, /installTranslationTaskCancel/u);
});

test("webpage translation never marks page Text nodes with data attributes", () => {
  assert.doesNotMatch(webpageTranslate, /data-mt-web-translated/u);
  assert.match(webpageTranslate, /createWebpageNodeStateStore/u);
  assert.match(webpageTranslate, /shouldApplyTranslation/u);
  assert.match(webpageTranslate, /shouldRestoreNode/u);
  // 扫描前清理断开节点与页面改写节点
  assert.match(webpageTranslate, /state\.nodeStore\.prune\(\)/u);
  assert.match(webpageTranslate, /isNodeModifiedByPage/u);
});

test("floating icon has a neutral placeholder on load failure", () => {
  const triple = fs.readFileSync(path.join(root, "extension", "src", "content", "modules", "controls-triple.js"), "utf8");
  assert.match(triple, /addEventListener\("error"/u);
  assert.match(triple, /mtPlaceholder/u);
  assert.match(triple, /data:image\/svg\+xml/u);
});

test("main-world route bridge is injected and listened for", () => {
  const observer = fs.readFileSync(path.join(root, "extension", "src", "content", "modules", "route-observer.js"), "utf8");
  assert.match(observer, /injectMainWorldRouteBridge/u);
  assert.match(observer, /mt-route-change/u);
  assert.match(observer, /buildMainWorldBridgeSource/u);
});
