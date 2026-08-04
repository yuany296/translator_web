import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("settings center owns advanced configuration and data management", () => {
  const html = read("extension", "public", "settings.html");
  const source = read("extension", "src", "settings", "controller.js");
  for (const route of ["general", "ocr", "translation", "reading", "glossary", "translations", "maintenance"]) {
    assert.match(html, new RegExp(`data-route="${route}"`));
    assert.match(html, new RegExp(`data-panel="${route}"`));
  }
  assert.match(html, /glossary\.html\?embedded=1/);
  assert.match(html, /translations\.html\?embedded=1/);
  assert.match(source, /TEST_OCR_CONFIGURATION/);
  assert.match(source, /TEST_TRANSLATION_CONFIGURATION/);
  assert.match(source, /PAIR_LOCAL_SERVICE/);
  assert.match(source, /response\.verified !== true/);
  assert.match(source, /认证正常/);
  assert.match(source, /GET_CACHE_STATS/);
  assert.match(source, /CLEAR_CACHE/);
  assert.doesNotMatch(html, /id="ocrLang"/);
});

test("legacy data pages route into their management-center sections", () => {
  assert.match(read("extension", "src", "glossary", "index.js"), /settings\.html#glossary/);
  assert.match(read("extension", "src", "translations", "index.js"), /settings\.html#translations/);
});

test("quick popup contains only high-frequency controls", () => {
  const manifest = JSON.parse(read("extension", "public", "manifest.json"));
  const html = read("extension", "public", manifest.action.default_popup);
  assert.match(html, /id="runtimeEnabled"/);
  assert.match(html, /id="sourceLanguage"/);
  assert.match(html, /id="targetLanguage"/);
  assert.match(html, /name="displayMode"/);
  assert.match(html, /id="translateBtn"/);
  assert.match(html, /id="settingsBtn"/);
  assert.doesNotMatch(html, /API Key|Provider|配对码|id="clearCacheBtn"|id="glossaryBtn"|id="translationLibraryBtn"/);
  assert.match(read("extension", "public", "popup.html"), /url=quick-popup\.html/);
  const lifecycle = read("extension", "src", "content", "modules", "lifecycle-bubble.js");
  const embedded = read("extension", "src", "content", "modules", "renderer-embed.js");
  assert.match(lifecycle, /state\.displayMode === "bilingual"/);
  assert.match(embedded, /state\.displayMode === "bilingual"/);
});
