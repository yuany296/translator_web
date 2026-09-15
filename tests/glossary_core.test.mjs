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
      libraryId: "default", scope: "global", scopeKey: "", scopeLabel: "" },
    { id: "disabled", source: "왕국", target: "王国", note: "", enabled: false,
      libraryId: "default", scope: "global", scopeKey: "", scopeLabel: "" }
  ]);
  assert.deepEqual(normalized.libraries.map(library => library.id), ["default"]);
});

test("legacy glossaries without libraries migrate every entry into the default library", () => {
  const normalized = glossary.normalizeGlossary({
    libraries: [{ id: "kakao-1", name: "骸骨皇女", enabled: true, urls: ["https://page.kakao.com/content/69299983/"] }],
    entries: [
      { id: "kept", source: "성현", target: "成贤", libraryId: "kakao-1" },
      { id: "orphan", source: "왕국", target: "王国", libraryId: "missing-library" },
      { id: "legacy", source: "마법", target: "魔法" }
    ]
  });

  assert.deepEqual(normalized.entries.map(entry => [entry.id, entry.libraryId]), [
    ["kept", "kakao-1"], ["orphan", "default"], ["legacy", "default"]
  ]);
  assert.equal(normalized.libraries[0].id, "default");
  assert.equal(normalized.libraries[1].urls[0], "https://page.kakao.com/content/69299983");
});

test("disabling a library removes only its terms from prompts and fingerprints", () => {
  const value = {
    libraries: [
      { id: "default", name: "默认术语库", enabled: true, urls: [] },
      { id: "novel", name: "骸骨皇女", enabled: true, urls: [] }
    ],
    entries: [
      { source: "성현", target: "成贤" },
      { source: "왕국", target: "王国", libraryId: "novel" }
    ]
  };
  const shared = [{ original_text: "성현이 말했다" }];
  const novelOnly = [{ original_text: "왕국이 무너졌다" }];

  assert.deepEqual(glossary.getRelevantEntries(value, novelOnly).map(entry => entry.target), ["王国"]);
  const fingerprintEnabled = glossary.getFingerprint(value);

  const disabled = {
    ...value,
    libraries: value.libraries.map(library => library.id === "novel" ? { ...library, enabled: false } : library)
  };
  // 停用库的术语不参与翻译，但同库之外的术语完全不受影响。
  assert.deepEqual(glossary.getRelevantEntries(disabled, novelOnly), []);
  assert.deepEqual(glossary.getRelevantEntries(disabled, shared).map(entry => entry.target), ["成贤"]);
  assert.notEqual(glossary.getFingerprint(disabled), fingerprintEnabled);

  const bothOff = {
    ...disabled,
    libraries: disabled.libraries.map(library => ({ ...library, enabled: false }))
  };
  assert.equal(glossary.buildPrompt(bothOff, shared), "");
});

test("same source term may live in two libraries and library order breaks the tie", () => {
  const value = {
    libraries: [
      { id: "default", name: "默认术语库", enabled: true, urls: [] },
      { id: "first", name: "第一本", enabled: true, urls: [] },
      { id: "second", name: "第二本", enabled: true, urls: [] }
    ],
    entries: [
      { source: "성현", target: "第一本译名", libraryId: "first" },
      { source: "성현", target: "第二本译名", libraryId: "second" }
    ]
  };

  // 同一原文跨库共存（不会被去重吃掉）
  assert.equal(glossary.normalizeGlossary(value).entries.length, 2);
  assert.deepEqual(
    glossary.getRelevantEntries(value, [{ original_text: "성현" }]).map(entry => entry.target),
    ["第一本译名"]
  );

  // 本书范围永远覆盖全局范围，即使全局条目来自更靠前的库
  const bookScoped = {
    libraries: value.libraries,
    entries: [
      { source: "성현", target: "第一本全局", libraryId: "first" },
      { source: "성현", target: "本书译名", libraryId: "second", scope: "work", scopeKey: "kakao:69299983" }
    ]
  };
  assert.deepEqual(
    glossary.getRelevantEntries(bookScoped, [{ original_text: "성현" }], { scopeKey: "kakao:69299983" })
      .map(entry => entry.target),
    ["本书译名"]
  );
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
  assert.match(prompt, /verbatim/);
  assert.match(prompt, /完整称谓/);
  assert.match(prompt, /pronouns/);
});

test("Hangul matching allows honorific name suffixes after terms", () => {
  assert.equal(glossary.matchesSourceTerm("수아씨는 고개를 끄덕였다.", "수아"), true);
  assert.equal(glossary.matchesSourceTerm("수아님이 그렇게 말했다.", "수아"), true);
  assert.equal(glossary.matchesSourceTerm("수아양이 살짝 웃었다.", "수아"), true);
  assert.equal(glossary.matchesSourceTerm("수아께서 먼저 나섰다.", "수아"), true);
  assert.equal(glossary.matchesSourceTerm("수아장이 말했다.", "수아"), false);
  // 已知取舍：양/군/씨 也是普通音节，极少数复合词(如 소양)会误命中，代价只是一次重试。
  assert.equal(glossary.matchesSourceTerm("소양이 높은 사람", "소"), true);
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

test("Latin glossary matching is case-insensitive and respects word boundaries", () => {
  assert.equal(glossary.matchesSourceTerm("Harry Potter walked in", "harry potter"), true);
  assert.equal(glossary.matchesSourceTerm("HARRY POTTER walked in", "harry"), true);
  assert.equal(glossary.matchesSourceTerm("The king rules the kingdom", "king"), true);
  assert.equal(glossary.matchesSourceTerm("The king rules the kingdom", "the"), true);
  assert.equal(glossary.matchesSourceTerm("kingdom of the deep", "king"), false);
  assert.equal(glossary.matchesSourceTerm("Sakura arrived", "ak"), false);
  assert.equal(glossary.matchesSourceTerm("AK-47 rifle", "ak"), true);
  assert.equal(glossary.matchesSourceTerm("Goku's power", "goku"), true);
  assert.equal(glossary.matchesSourceTerm("Gokus arrived", "goku"), false);
  assert.equal(glossary.matchesSourceTerm("孙悟空来了", "悟空"), true);
});

test("glossary normalization deduplicates source terms ignoring case", () => {
  const normalized = glossary.normalizeGlossary({
    entries: [
      { id: "upper", source: "Harry Potter", target: "哈利·波特" },
      { id: "lower", source: "harry potter", target: "哈利波特" }
    ]
  });
  assert.deepEqual(normalized.entries.map(entry => entry.id), ["upper"]);
  const relevant = glossary.getRelevantEntries(normalized, [
    { original_text: "harry potter appeared" }
  ]);
  assert.deepEqual(relevant.map(entry => entry.target), ["哈利·波特"]);
});

test("effective glossary changes produce a different fingerprint", () => {
  const first = { entries: [{ source: "성현", target: "成贤", enabled: true }] };
  const changedTarget = { entries: [{ source: "성현", target: "圣贤", enabled: true }] };
  const disabled = { entries: [{ source: "성현", target: "成贤", enabled: false }] };

  assert.notEqual(glossary.getFingerprint(first), glossary.getFingerprint(changedTarget));
  assert.notEqual(glossary.getFingerprint(first), glossary.getFingerprint(disabled));
  assert.equal(glossary.buildPrompt(disabled, [{ original_text: "성현" }]), "");
  // 指纹版本随多术语库升级为 g4，旧的 g3 缓存键整体失效重建。
  assert.match(glossary.getFingerprint(first), /^g4-/);
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
