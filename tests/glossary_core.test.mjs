import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import glossary from "../extension/src/shared/glossary.js";

const root = path.resolve(import.meta.dirname, "..");

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
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.entries.map(
    ({ sourceLanguage, targetLanguage, workId, ...entry }) => entry
  ))), [
    { id: "first", source: "성현", target: "成贤", note: "角色名", enabled: true,
      scope: "global", scopeKey: "", scopeLabel: "" },
    { id: "disabled", source: "왕국", target: "王国", note: "", enabled: false,
      scope: "global", scopeKey: "", scopeLabel: "" }
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

test("Hangul glossary matching respects word boundaries and permits particles", () => {
  const value = {
    entries: [
      { source: "양", target: "绵羊" },
      { source: "문양", target: "纹样" },
      { source: "이사", target: "理事" }
    ]
  };
  const embedded = glossary.getRelevantEntries(value, [
    { original_text: "외양만 보았고 모양새와 의기양양한 태도를 확인했다. 양손으로 이사장을 맞았다." }
  ]);
  assert.deepEqual(embedded.map(entry => entry.source), []);

  const standalone = glossary.getRelevantEntries(value, [
    { original_text: "양이 있고 문양을 확인했다. 이사가 말했다." }
  ]);
  assert.deepEqual(
    standalone.map(entry => entry.source).sort(),
    ["양", "문양", "이사"].sort()
  );
  assert.equal(glossary.matchesSourceTerm("외양만 문양이 모양새 의기양양", "양"), false);
  assert.equal(glossary.matchesSourceTerm("양은 들판에 있다.", "양"), true);
  assert.equal(glossary.matchesSourceTerm("이사장이 말했다.", "이사"), false);
  assert.equal(glossary.matchesSourceTerm("이사가 말했다.", "이사"), true);
});

test("effective glossary changes produce a different fingerprint", () => {
  const first = { entries: [{ source: "성현", target: "成贤", enabled: true }] };
  const changedTarget = { entries: [{ source: "성현", target: "圣贤", enabled: true }] };
  const disabled = { entries: [{ source: "성현", target: "成贤", enabled: false }] };

  assert.notEqual(glossary.getFingerprint(first), glossary.getFingerprint(changedTarget));
  assert.notEqual(glossary.getFingerprint(first), glossary.getFingerprint(disabled));
  assert.equal(glossary.buildPrompt(disabled, [{ original_text: "성현" }]), "");
});

test("extension exposes the management center and removes direct vision providers", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "public", "manifest.json"), "utf8"));
  const settings = fs.readFileSync(path.join(root, "extension", "public", "settings.html"), "utf8");
  const settingsScript = fs.readFileSync(path.join(root, "extension", "src", "settings", "controller.js"), "utf8");

  assert.equal(manifest.options_ui.page, "settings.html");
  assert.ok(!manifest.host_permissions.includes("https://api.anthropic.com/*"));
  assert.match(settings, /value="baidu"/);
  assert.match(settings, /value="local_paddle"/);
  assert.doesNotMatch(settings, /baidu_deepseek|local_paddle_deepseek|value="anthropic"/);
  assert.doesNotMatch(settingsScript, /baidu_deepseek|local_paddle_deepseek|anthropic/);
});

test("management center exposes glossary and pending-term confirmation controls", () => {
  const glossaryPage = fs.readFileSync(path.join(root, "extension", "public", "glossary.html"), "utf8");
  const glossarySource = path.join(root, "extension", "src", "glossary");
  const glossaryScript = [
    fs.readFileSync(path.join(glossarySource, "index.js"), "utf8"),
    ...fs.readdirSync(path.join(glossarySource, "modules"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => fs.readFileSync(path.join(glossarySource, "modules", name), "utf8"))
  ].join("\n");
  const settings = fs.readFileSync(path.join(root, "extension", "public", "settings.html"), "utf8");

  assert.match(glossaryPage, /id="pendingTabBtn"/);
  assert.match(glossaryPage, /id="confirmFilledBtn"/);
  assert.match(glossaryPage, /id="ignoreAllBtn"/);
  assert.match(glossaryScript, /CONFIRM_TERM_CANDIDATES/);
  assert.match(glossaryScript, /IGNORE_TERM_CANDIDATE/);
  assert.match(glossaryScript, /IGNORE_TERM_CANDIDATES/);
  assert.match(glossaryScript, /ignore-chapter-all/);
  assert.match(glossaryScript, /ignoreAllPendingCandidates/);
  assert.match(glossaryScript, /RESTORE_IGNORED_TERM/);
  assert.match(glossaryScript, /candidate-source-input/);
  assert.match(glossaryScript, /candidateSource/);
  assert.match(settings, /data-route="glossary"/);
  assert.match(settings, /id="glossaryFrame"/);
  assert.match(settings, /id="termDiscoveryEnabled"/);
});
