import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 两端提取的「单一真源」检查：桌面走本地服务里的 Python 提示词与校验，
 * 手机走 novel-mobile/term-extract-prompt.js 的移植版。任何一边改了规则，
 * 同一个模型在两个端上就会给出不同质量的候选 —— 用户实测「手机漏术语」时
 * 最先被怀疑的就是这里，所以用测试把两边钉在一起。
 *
 * 这里做的是文本级比对（Node 不能 import Python）：从 JS 源里抠出提示词行与两张
 * 容错表的键，逐个在 Python 源里找。Python 侧的语义测试在 tests/test_term_extractor.py。
 */
const root = path.resolve(import.meta.dirname, "..");
const jsSource = fs.readFileSync(
  path.join(root, "extension", "src", "novel-mobile", "term-extract-prompt.js"), "utf8"
);
const pySource = fs.readFileSync(path.join(root, "local-ocr-service", "term_extractor.py"), "utf8");

/** 抠出 buildChunkPrompt 里那些「逐字固定」的提示词行（模板行单独比）。 */
function jsPromptLines() {
  const start = jsSource.indexOf("function buildChunkPrompt");
  const end = jsSource.indexOf("].join(\"\\n\");", start);
  const block = jsSource.slice(start, end);
  const lines = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/gu;
  let match = pattern.exec(block);
  while (match) {
    lines.push(match[1].replace(/\\"/gu, "\"").replace(/\\n/gu, "\n"));
    match = pattern.exec(block);
  }
  return lines;
}

function jsSetKeys(name) {
  const start = jsSource.indexOf(`const ${name} = new Set([`);
  assert.notEqual(start, -1, `JS 里找不到 ${name}`);
  const end = jsSource.indexOf("]);", start);
  const block = jsSource.slice(start, end);
  const keys = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/gu;
  let match = pattern.exec(block);
  while (match) {
    keys.push(match[1]);
    match = pattern.exec(block);
  }
  return keys;
}

/** 抠出 `const NAME = new Map([["a", …]])` 的键。 */
function jsMapKeys(name) {
  const start = jsSource.indexOf(`const ${name} = new Map([`);
  assert.notEqual(start, -1, `JS 里找不到 ${name}`);
  const end = jsSource.indexOf("]);", start);
  const block = jsSource.slice(start, end);
  const keys = [];
  const pattern = /\["((?:[^"\\]|\\.)*)"/gu;
  let match = pattern.exec(block);
  while (match) {
    keys.push(match[1]);
    match = pattern.exec(block);
  }
  return keys;
}

/** 抠出 `const NAME = Object.freeze({ a: [...], b: [...] })` 的键。 */
function jsObjectKeys(name) {
  const start = jsSource.indexOf(`const ${name} = Object.freeze({`);
  assert.notEqual(start, -1, `JS 里找不到 ${name}`);
  const end = jsSource.indexOf("});", start);
  const block = jsSource.slice(start, end);
  const keys = [];
  const pattern = /(?:^|\n)\s*"?([A-Za-z_][\w]*)"?\s*:/gu;
  let match = pattern.exec(block);
  while (match) {
    // 只收顶层键（值里不会有 `xxx:` 形状的属性）
    keys.push(match[1]);
    match = pattern.exec(block);
  }
  return keys;
}

test("提示词逐行一致：JS 的每条固定规则都能在 Python 里找到", () => {
  const lines = jsPromptLines();
  assert.ok(lines.length >= 10, "提示词行数不对，抠取逻辑可能失效");
  const missing = lines.filter(line => {
    // 模板行（含 ${…}）单独比对目标语言，这里只比固定行
    if (line.includes("${")) return false;
    return !pySource.includes(line);
  });
  assert.deepEqual(missing, [], "这些提示词行只在手机版有，桌面版漏了");
});

test("提示词里的目标语言插值两边都在", () => {
  assert.match(jsSource, /`- 目标语言为 \$\{targetLanguage\}`/u);
  assert.match(pySource, /f"- 目标语言为 \{target_language\}"/u);
});

test("kind 白名单与别名表逐键一致（含「必须丢弃」的词性表）", () => {
  const jsValid = jsSetKeys("VALID_KINDS").sort();
  const pyValid = pySource.match(/^VALID_KINDS = \{([^}]*)\}/mu)[1]
    .match(/"([a-z_]+)"/gu).map(value => value.replace(/"/gu, "")).sort();
  assert.deepEqual(jsValid, pyValid, "有效 kind 白名单不一致");

  const jsKindAliases = jsMapKeys("KIND_ALIASES").sort();
  const pyKindAliases = pySource.match(/^KIND_ALIASES = \{([\s\S]*?)^\}/mu)[1]
    .match(/"[^"]+":/gu).map(value => value.replace(/":$/u, "").replace(/^"/u, "")).sort();
  assert.deepEqual(jsKindAliases, pyKindAliases, "kind 别名表不一致");

  const jsInvalid = jsSetKeys("INVALID_KIND_ALIASES").sort();
  const pyInvalid = pySource.match(/^INVALID_KIND_ALIASES = \{([\s\S]*?)^\}/mu)[1]
    .match(/"[^"]+"/gu).map(value => value.replace(/"/gu, "")).sort();
  assert.deepEqual(jsInvalid, pyInvalid, "无效 kind 表不一致");
});

test("字段别名表逐键一致", () => {
  const jsFieldAliases = jsObjectKeys("FIELD_ALIASES").sort();
  assert.deepEqual(jsFieldAliases, ["kind", "note", "source", "target"], "抠取逻辑失效");
  const pyFieldAliases = pySource.match(/^FIELD_ALIASES = \{([\s\S]*?)^\}/mu)[1]
    .match(/"[^"]+":/gu).map(value => value.replace(/":$/u, "").replace(/^"/u, "")).sort();
  assert.deepEqual(jsFieldAliases, pyFieldAliases, "字段别名表不一致");
});

test("分块与模型解析的关键常量两边一致", () => {
  assert.match(jsSource, /const LLM_MAX_CHUNK_CHARS = 3000;/u);
  assert.match(pySource, /^LLM_MAX_CHUNK_CHARS = 3000$/mu);
  assert.match(jsSource, /const LLM_CHUNK_OVERLAP = 200;/u);
  assert.match(pySource, /^LLM_CHUNK_OVERLAP = 200$/mu);
  assert.match(jsSource, /const DEFAULT_KIND_SCORE = 0\.85;/u);
  assert.match(pySource, /return scores\.get\(kind, 0\.85\)/u);
  // 未配置模型时的报错文案必须一致，否则两端「失败原因」看起来不一样
  const message = "未配置术语提取模型：请在设置页「翻译服务」里为整章术语提取选择带 model 的配置";
  assert.ok(jsSource.includes(message), "手机版缺少模型未配置的提示");
  assert.ok(pySource.includes(message), "桌面版缺少模型未配置的提示");
});
