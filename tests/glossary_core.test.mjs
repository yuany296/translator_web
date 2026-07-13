import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "glossary-core.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(`${source}\nglobalThis.__glossaryTest = MangaGlossary;`, context, {
  filename: "glossary-core.js"
});
const glossary = context.__glossaryTest;

test("glossary normalization rejects invalid and duplicate source terms", () => {
  const normalized = glossary.normalizeGlossary({
    revision: 4.8,
    entries: [
      { id: "first", source: " 성현 ", target: "成贤", note: "角色名", enabled: true },
      { id: "duplicate", source: "성현", target: "圣贤" },
      { id: "disabled", source: "왕국", target: "王国", enabled: false },
      { id: "invalid", source: "", target: "空" }
    ]
  });

  assert.equal(normalized.revision, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.entries)), [
    { id: "first", source: "성현", target: "成贤", note: "角色名", enabled: true },
    { id: "disabled", source: "왕국", target: "王国", note: "", enabled: false }
  ]);
});

test("glossary prompt includes only enabled terms present in current OCR blocks", () => {
  const value = {
    entries: [
      { source: "성현 공작", target: "成贤公爵", note: "完整称谓" },
      { source: "성현", target: "成贤" },
      { source: "왕국", target: "王国", enabled: false },
      { source: "마법사", target: "魔法师" }
    ]
  };
  const prompt = glossary.buildPrompt(value, [{ original_text: "성현 공작이 도착했다" }]);

  assert.match(prompt, /성현 공작/);
  assert.match(prompt, /成贤公爵/);
  assert.match(prompt, /성현/);
  assert.doesNotMatch(prompt, /왕국/);
  assert.doesNotMatch(prompt, /마법사/);
  assert.ok(prompt.indexOf("성현 공작") < prompt.lastIndexOf('"성현"'));
});

test("effective glossary changes produce a different fingerprint", () => {
  const first = { entries: [{ source: "성현", target: "成贤", enabled: true }] };
  const changedTarget = { entries: [{ source: "성현", target: "圣贤", enabled: true }] };
  const disabled = { entries: [{ source: "성현", target: "成贤", enabled: false }] };

  assert.notEqual(glossary.getFingerprint(first), glossary.getFingerprint(changedTarget));
  assert.notEqual(glossary.getFingerprint(first), glossary.getFingerprint(disabled));
  assert.equal(glossary.buildPrompt(disabled, [{ original_text: "성현" }]), "");
});

test("extension exposes the glossary page and removes direct vision providers", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const popup = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  const popupScript = fs.readFileSync(path.join(root, "popup.js"), "utf8");

  assert.equal(manifest.options_ui.page, "glossary.html");
  assert.ok(!manifest.host_permissions.includes("https://api.anthropic.com/*"));
  assert.doesNotMatch(popup, /value="anthropic"|value="openai_compatible"/);
  assert.doesNotMatch(popupScript, /safe === "anthropic"|safe === "openai_compatible"/);
});

test("glossary and popup expose pending-term confirmation controls", () => {
  const glossaryPage = fs.readFileSync(path.join(root, "glossary.html"), "utf8");
  const glossaryScript = fs.readFileSync(path.join(root, "glossary.js"), "utf8");
  const popup = fs.readFileSync(path.join(root, "popup.html"), "utf8");

  assert.match(glossaryPage, /id="pendingTabBtn"/);
  assert.match(glossaryPage, /id="confirmFilledBtn"/);
  assert.match(glossaryScript, /CONFIRM_TERM_CANDIDATES/);
  assert.match(glossaryScript, /IGNORE_TERM_CANDIDATE/);
  assert.match(glossaryScript, /RESTORE_IGNORED_TERM/);
  assert.match(glossaryScript, /candidate-source-input/);
  assert.match(glossaryScript, /candidateSource/);
  assert.match(popup, /id="termDiscoverySwitch"/);
  assert.match(popup, /id="termDiscoveryStatus"/);
});
