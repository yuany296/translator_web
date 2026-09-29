import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import glossary from "../extension/src/shared/glossary.js";
import languages from "../extension/src/shared/languages.js";

/**
 * 跨端语言码契约：本地服务 `glossary_store/common.py#normalize_tgt_lng` 会把
 * `ja` 升格成 `ja-JP` 落库并原样回传，扩展侧必须能折回 `ja`。
 * 历史 bug：不做归一，`entry.targetLanguage === targetLanguage` 在日语/韩语/
 * 英语目标下永远不成立 → 同步过的词条整库被静默滤掉（提示词与指纹都没有）。
 */

const LIBRARY = { id: "default", name: "默认术语库", enabled: true, urls: [], applyUrls: [] };

function glossaryWithTarget(targetLanguage) {
  return glossary.normalizeGlossary({
    version: 4,
    libraries: [LIBRARY],
    entries: [{
      id: "gio", source: "지오", target: "地奥", note: "",
      sourceLanguage: "ko", targetLanguage, libraryId: "default", enabled: true, scope: "global"
    }]
  });
}

test("服务端回传的区域码在入库时折回规范短码", () => {
  const normalized = glossaryWithTarget("ja-JP");
  assert.equal(normalized.entries[0].targetLanguage, "ja");
  assert.deepEqual(glossary.getEnabledEntries(normalized, {
    targetLanguage: "ja", sourceLanguage: "ko"
  }).map(entry => entry.id), ["gio"]);
  assert.deepEqual(glossary.getEnabledEntries(normalized, {
    targetLanguage: "zh-CN", sourceLanguage: "ko"
  }), [], "不同目标语言的词条不得混进来");
});

test("反向：本地存短码、上下文给区域码同样命中", () => {
  const normalized = glossaryWithTarget("ja");
  assert.deepEqual(glossary.getEnabledEntries(normalized, {
    targetLanguage: "ja-JP", sourceLanguage: "ko"
  }).map(entry => entry.id), ["gio"]);
});

test("ja/ko/en/zh-CN/zh-TW 五种目标语言往返都稳定", () => {
  for (const [short, dialect] of [
    ["ja", "ja-JP"], ["ko", "ko-KR"], ["en", "en-US"],
    ["zh-CN", "zh-CN"], ["zh-TW", "zh-TW"]
  ]) {
    const normalized = glossaryWithTarget(dialect);
    assert.equal(normalized.entries[0].targetLanguage, short, `${dialect} 应折回 ${short}`);
    assert.equal(glossary.getEnabledEntries(normalized, {
      targetLanguage: short, sourceLanguage: "ko"
    }).length, 1, `目标 ${short} 必须命中`);
  }
});

test("未知语言码原样保留：不得回落成 zh-CN 而误匹配中文请求", () => {
  const normalized = glossaryWithTarget("fr");
  assert.equal(normalized.entries[0].targetLanguage, "fr");
  assert.deepEqual(glossary.getEnabledEntries(normalized, {
    targetLanguage: "zh-CN", sourceLanguage: "ko"
  }), []);
  // UI 下拉用的归一函数保持原语义：未知码回落默认值
  assert.equal(languages.normalizeTargetLanguage("fr"), "zh-CN");
});

test("同一词条存成 ja 与 ja-JP 得到同一个 g4- 指纹，提示词一致", () => {
  const fromServer = glossaryWithTarget("ja-JP");
  const fromLocal = glossaryWithTarget("ja");
  assert.equal(glossary.getFingerprint(fromServer), glossary.getFingerprint(fromLocal));
  const prompt = glossary.buildPrompt(fromServer, [{ original_text: "지오의 초상화" }], {
    targetLanguage: "ja", sourceLanguage: "ko"
  });
  assert.match(prompt, /地奥/u, "术语必须真的注入提示词");
});

test("源语言别名同样归一", () => {
  const normalized = glossary.normalizeGlossary({
    version: 4,
    libraries: [LIBRARY],
    entries: [{
      id: "a", source: "지오", target: "地奥", sourceLanguage: "korean",
      targetLanguage: "zh-CN", libraryId: "default", enabled: true, scope: "global"
    }]
  });
  assert.equal(normalized.entries[0].sourceLanguage, "ko");
});

test("大小写不敏感：zh-cn / JA-JP 都折回规范短码", () => {
  assert.equal(languages.canonicalTargetLanguage("zh-cn"), "zh-CN");
  assert.equal(languages.canonicalTargetLanguage("JA-JP"), "ja");
  assert.equal(languages.canonicalTargetLanguage("  ko-KR  "), "ko");
});

test("别名表与本地服务 normalize_tgt_lng 的升格规则保持同步", () => {
  const pythonSource = readFileSync(
    new URL("../local-ocr-service/glossary_store/common.py", import.meta.url), "utf8"
  );
  // [Python 的短码, Python 升格后的值, 扩展侧的规范码]
  // zh 是唯一"升格后就已经是规范码"的一对；其余三个都要折回两字母短码。
  for (const [short, dialect, canonical] of [
    ["zh", "zh-CN", "zh-CN"], ["ko", "ko-KR", "ko"], ["ja", "ja-JP", "ja"], ["en", "en-US", "en"]
  ]) {
    assert.match(pythonSource, new RegExp(`"${short}": "${dialect}"`, "u"),
      `common.py 的升格映射必须仍包含 ${short} → ${dialect}（改了就要同步扩展侧别名表）`);
    assert.equal(languages.canonicalTargetLanguage(dialect), canonical);
    assert.ok(languages.TARGET_LANGUAGES.includes(canonical),
      `${dialect} 必须能折回扩展侧的规范目标码，否则同步过的词条会被整库滤掉`);
  }
});
