import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import glossary from "../extension/src/shared/glossary.js";
import novel from "../extension/src/shared/novel.js";
import novelMemory from "../extension/src/shared/novel-memory.js";
import { normalizeRuntimeConfig } from "../extension/src/config/schema.js";
import {
  buildNovelProgressView
} from "../extension/src/content/modules/novel-progress-panel.js";

const root = path.resolve(import.meta.dirname, "..");

test("Kakao novel location and paragraph chunking preserve stable reading identities", () => {
  const location = novel.parseKakaoNovelLocation(
    "https://page.kakao.com/content/65171279/viewer/70081892/?mode=scroll",
    "괴담에 떨어져도 출근을 해야 하는구나 399화"
  );
  assert.deepEqual(location, {
    seriesId: "65171279",
    chapterId: "70081892",
    scopeKey: "kakao:65171279",
    chapterOrder: 399,
    chapterTitle: "괴담에 떨어져도 출근을 해야 하는구나 399화"
  });
  const items = [
    { id: "p-1", original_text: "가".repeat(1500) },
    { id: "p-2", original_text: "나".repeat(1000) },
    { id: "p-3", original_text: "다".repeat(100) }
  ];
  const chunks = novel.buildChunks(items, 2400);
  assert.deepEqual(chunks.map(chunk => chunk.map(item => item.id)), [["p-1"], ["p-2", "p-3"]]);
  assert.equal(chunks.flat().map(item => item.original_text).join(""), items.map(item => item.original_text).join(""));
});

test("book glossary overrides global terms and validation rejects a free rename", () => {
  const value = glossary.normalizeGlossary({
    entries: [
      { source: "성현", target: "成贤", scope: "global" },
      { source: "성현", target: "晟玄", scope: "series", scopeKey: "kakao:1" },
      { source: "왕국", target: "王国", scope: "series", scopeKey: "kakao:2" }
    ]
  });
  const effective = glossary.getRelevantEntries(value, [
    { id: "p1", original_text: "성현이 왔다" }
  ], { scopeKey: "kakao:1" });
  assert.deepEqual(effective.map(entry => entry.target), ["晟玄"]);
  const invalid = novel.validateTranslations(
    [{ id: "p1", original_text: "성현이 왔다" }],
    [{ id: "p1", translated_text: "成贤来了" }],
    effective
  );
  assert.equal(invalid.accepted.length, 0);
  assert.equal(invalid.errors[0].code, "glossary_violation");
  assert.deepEqual(invalid.glossaryFallbacks, [{
    id: "p1", translated_text: "成贤来了", terms: ["성현"]
  }]);
  const untranslated = novel.validateTranslations(
    [{ id: "p2", original_text: "평범한 하루였다." }],
    [{ id: "p2", translated_text: "평범한 하루였다." }]
  );
  assert.equal(untranslated.errors[0].code, "source_language_leak");
  assert.deepEqual(untranslated.glossaryFallbacks, []);
});

test("novel glossary validation ignores terms embedded in longer Hangul words", () => {
  const entries = [
    { source: "양", target: "绵羊" },
    { source: "이사", target: "理事" }
  ];
  const embedded = novel.validateTranslations([
    { id: "short", original_text: "외양만 보고 모양새를 확인했다." },
    { id: "long", original_text: "이사장이 말했다." }
  ], [
    { id: "short", translated_text: "只看了外表，又确认了一下样子。" },
    { id: "long", translated_text: "董事长开口说道。" }
  ], entries);
  assert.equal(embedded.errors.length, 0);
  assert.deepEqual(embedded.accepted.map(row => row.id), ["short", "long"]);

  const standalone = novel.validateTranslations([
    { id: "short", original_text: "양이 들판에 있다." },
    { id: "long", original_text: "이사가 말했다." }
  ], [
    { id: "short", translated_text: "羊在田野里。" },
    { id: "long", translated_text: "董事开口说道。" }
  ], entries);
  assert.deepEqual(
    standalone.errors.map(error => [error.id, error.code, error.terms]),
    [
      ["short", "glossary_violation", ["양"]],
      ["long", "glossary_violation", ["이사"]]
    ]
  );
  assert.deepEqual(standalone.glossaryFallbacks.map(row => row.id), ["short", "long"]);
});

test("novel glossary validation checks the target case-insensitively", () => {
  const entries = [{ source: "Harry Potter", target: "Harry Potter" }];
  const accepted = novel.validateTranslations([
    { id: "p1", original_text: "Harry Potter appeared" }
  ], [
    { id: "p1", translated_text: "harry potter 出现了" }
  ], entries);
  assert.equal(accepted.errors.length, 0);
  assert.deepEqual(accepted.accepted.map(row => row.id), ["p1"]);
});

test("novel diagnostics summarize validation and provider failures without source text", () => {
  const summary = novel.summarizeTranslationErrors([
    { id: "123", code: "glossary_violation", terms: ["아이템"] },
    { id: "305", code: "missing_translation" },
    { id: "retry", error: "provider timeout" }
  ]);
  assert.match(summary.text, /术语不一致 1 段/u);
  assert.match(summary.text, /响应缺少 ID\/译文 1 段/u);
  assert.match(summary.text, /API 请求失败 1 段/u);
  assert.equal(summary.errors[0].id, "123");
  assert.equal(summary.errors[0].terms[0], "아이템");
  const warnings = novel.summarizeTranslationWarnings([
    { id: "123", code: "glossary_warning", terms: ["아이템"] },
    { id: "123", code: "glossary_warning", terms: ["아이템"] }
  ]);
  assert.equal(warnings.text, "已保留全部译文，其中 1 段未完全采用术语表指定译名。");
  assert.equal(warnings.warnings[0].code, "glossary_warning");
});

test("novel validation flags merged duplicate translations for per-segment retry", () => {
  // 模型把相邻两段合并后用同一译文回给两个 id：归一化译文相同、原文不同 → 后一段报错补翻。
  const duplicate = novel.validateTranslations(
    [
      { id: "p1", original_text: "첫째 문장이 여기에 있습니다." },
      { id: "p2", original_text: "둘째 문장은 완전히 다릅니다." }
    ],
    [
      { id: "p1", translated_text: "他说明天一早就动身回来。" },
      { id: "p2", translated_text: "他说明天 一早就动身回来。" }
    ]
  );
  assert.deepEqual(duplicate.accepted.map(row => row.id), ["p1"]);
  assert.deepEqual(duplicate.errors, [{ id: "p2", code: "duplicate_translation" }]);

  // 原文归一化后相同是小说里的真实重复句，两段都接受。
  const legitRepeat = novel.validateTranslations(
    [
      { id: "p1", original_text: "다시 한번 말해 줘." },
      { id: "p2", original_text: "다시 한번 말해 줘!" }
    ],
    [
      { id: "p1", translated_text: "请再说一遍。" },
      { id: "p2", translated_text: "请再说一遍。" }
    ]
  );
  assert.deepEqual(legitRepeat.accepted.map(row => row.id), ["p1", "p2"]);
  assert.equal(legitRepeat.errors.length, 0);

  // 归一化译文不足 4 字的合法短重复不标记。
  const shortRepeat = novel.validateTranslations(
    [
      { id: "p1", original_text: "네." },
      { id: "p2", original_text: "그래." }
    ],
    [
      { id: "p1", translated_text: "好。" },
      { id: "p2", translated_text: "好！" }
    ]
  );
  assert.deepEqual(shortRepeat.accepted.map(row => row.id), ["p1", "p2"]);
  assert.equal(shortRepeat.errors.length, 0);

  const summary = novel.summarizeTranslationErrors([{ id: "p2", code: "duplicate_translation" }]);
  assert.match(summary.text, /与相邻段落译文重复 1 段/u);
});

test("novel memory reads only an earlier checkpoint and isolates books", () => {
  let store = novelMemory.normalizeStore(null);
  store = novelMemory.saveCheckpoint(store, {
    key: "kakao:1", chapterId: "c1", chapterOrder: 1,
    memoryDeltas: [{ summary: "第一章", characters: ["甲"] }]
  }).store;
  store = novelMemory.saveCheckpoint(store, {
    key: "kakao:1", chapterId: "c3", chapterOrder: 3,
    memoryDeltas: [{ summary: "第三章", characters: ["丙"] }]
  }).store;
  store = novelMemory.saveCheckpoint(store, {
    key: "kakao:2", chapterId: "other", chapterOrder: 1,
    memoryDeltas: [{ summary: "另一本" }]
  }).store;
  const middle = novelMemory.getContext(store, "kakao:1", {
    chapterId: "c2", chapterOrder: 2
  });
  assert.match(middle.memory.summary, /第一章/u);
  assert.doesNotMatch(middle.memory.summary, /第三章|另一本/u);
});

test("novel memory 不把「话号认不出来」的快照当成前面的章节（回顾前面时不会被后面的记忆污染）", () => {
  // 用户场景：先看后面、再回看前面。话号没认出来的快照以前会被 Number(null)=0 存成第 0 话，
  // 在章节序里排在所有真实章节之前 → 每一话都会把它当成「前面的记忆」，于是前后颠倒。
  let store = novelMemory.normalizeStore({
    version: 1,
    books: [{
      key: "kakao:1", title: "骸骨皇女", revision: 1,
      checkpoints: [
        { chapterId: "cX", chapterTitle: "几十话之后的特别篇", chapterOrder: null, updatedAt: 900, memory: { summary: "后面的剧情" } },
        { chapterId: "c3", chapterTitle: "第3话", chapterOrder: 3, updatedAt: 300, memory: { summary: "第三章" } }
      ]
    }]
  });
  const book = novelMemory.getBook(store, "kakao:1");
  assert.equal(book.checkpoints.find(item => item.chapterId === "cX").chapterOrder, null,
    "话号认不出来要留空，不能变成 0 话");
  assert.notEqual(book.checkpoints[0].chapterId, "cX",
    "不能因为话号未知就排到最前面（那等于当成第 0 话）");

  // 回看第 1 话：只能用到「更早」的快照，这里一个都没有 → 不能把后面那话的记忆塞进来
  const first = novelMemory.getContext(store, "kakao:1", { chapterId: "c1", chapterOrder: 1 });
  assert.equal(first.checkpoint, null, "第 1 话前面没有快照，就该是空的");
  assert.equal(first.memory.summary, "");

  // 翻第 4 话：应当拿到第 3 话的累积，而不是那条话号未知的
  const fourth = novelMemory.getContext(store, "kakao:1", { chapterId: "c4", chapterOrder: 4 });
  assert.match(fourth.memory.summary, /第三章/u);
  assert.doesNotMatch(fourth.memory.summary, /后面的剧情/u);

  // 旧数据里已经存成 0 的，读出来也要被纠正成空
  store = novelMemory.normalizeStore({
    version: 1,
    books: [{
      key: "kakao:1", title: "骸骨皇女", revision: 1,
      checkpoints: [{ chapterId: "old", chapterTitle: "旧数据", chapterOrder: 0, updatedAt: 1, memory: { summary: "旧的" } }]
    }]
  });
  assert.equal(novelMemory.getBook(store, "kakao:1").checkpoints[0].chapterOrder, null);
});

test("同一话重翻/补翻是叠加不覆盖，而且每话的贡献能单独读出来（可拆分）", () => {
  let store = novelMemory.normalizeStore(null);
  const save = (chapterId, chapterOrder, memoryDeltas) => {
    store = novelMemory.saveCheckpoint(store, {
      key: "kakao:1", chapterId, chapterOrder, memoryDeltas
    }).store;
  };
  save("c3", 3, [{ summary: "第三章：甲出场", characters: ["甲"] }]);
  // 补翻（只重翻缺的几段）：这一话先前学到的「甲」不能被覆盖掉
  save("c3", 3, [{ summary: "第三章补翻：乙登场", characters: ["乙"] }]);
  const c3 = novelMemory.getBook(store, "kakao:1").checkpoints.find(item => item.chapterId === "c3");
  assert.deepEqual(c3.memory.characters, ["甲", "乙"], "同一话的两次翻译结果要叠加");
  assert.match(c3.memory.summary, /甲出场/u);
  assert.match(c3.memory.summary, /乙登场/u);
  assert.deepEqual(c3.delta.characters, ["甲", "乙"], "「本话新增」要能单独读出来");

  save("c8", 8, [{ summary: "第八章：甲成为国王", characters: ["甲"] }]);
  const c8 = novelMemory.getBook(store, "kakao:1").checkpoints.find(item => item.chapterId === "c8");
  assert.deepEqual(c8.memory.characters, ["甲", "乙"], "累计＝第 3 话 + 第 8 话");
  assert.deepEqual(c8.delta.characters, ["甲"], "第 8 话的新增只有甲，不含第 3 话的");

  // 回看第 3 话：拿到的是这一话自己已有的记忆，既不是空的，也不会带上第 8 话
  const back = novelMemory.getContext(store, "kakao:1", { chapterId: "c3", chapterOrder: 3 });
  assert.deepEqual(back.memory.characters, ["甲", "乙"]);
  assert.doesNotMatch(back.memory.summary, /第八章/u);
});

test("旧数据（没有 delta 的累计快照）继续能用：当基线，既不重复也不丢", () => {
  // 旧版把每话的累计整份存下来（摘要因此是层层拼接的），这里如实模拟
  const store0 = novelMemory.normalizeStore({
    version: 1,
    books: [{
      key: "kakao:1", title: "骸骨皇女", revision: 3,
      checkpoints: [
        { chapterId: "c1", chapterOrder: 1, revision: 1, updatedAt: 100, memory: { summary: "旧累计：开场", characters: ["甲"] } },
        { chapterId: "c3", chapterOrder: 3, revision: 2, updatedAt: 300, memory: { summary: "旧累计：开场\n旧累计：甲登场", characters: ["甲"] } }
      ]
    }]
  });
  const before = novelMemory.getBook(store0, "kakao:1");
  assert.equal(before.checkpoints.every(item => item.delta === null), true, "旧快照没有 delta");

  const store = novelMemory.saveCheckpoint(store0, {
    key: "kakao:1", chapterId: "c5", chapterOrder: 5,
    memoryDeltas: [{ summary: "第五章：乙登场", characters: ["乙"] }]
  }).store;
  const c5 = novelMemory.getBook(store, "kakao:1").checkpoints.find(item => item.chapterId === "c5");
  assert.match(c5.memory.summary, /旧累计：甲登场/u, "旧累计要作为基线保留");
  assert.equal(c5.memory.summary.match(/旧累计：开场/gu).length, 1, "更早的旧累计不能又被叠一遍");
  assert.match(c5.memory.summary, /第五章：乙登场/u);
  assert.deepEqual(c5.memory.characters, ["甲", "乙"]);
  assert.deepEqual(c5.delta.characters, ["乙"], "新数据本身仍然只记本话新增");
});

test("注入提示词的记忆会被结构化裁剪（长篇读久了也不会越带越多）", () => {
  const big = {
    summary: "甲".repeat(5000),
    characters: Array.from({ length: 60 }, (_, index) => ({ name: `角色${index}`, note: "备".repeat(60) })),
    relationships: Array.from({ length: 60 }, (_, index) => ({ subject: `角色${index}`, relation: "朋友" })),
    honorifics: Array.from({ length: 60 }, (_, index) => ({ source: `호칭${index}`, target: "大人" })),
    unresolved: Array.from({ length: 60 }, () => ({ note: "待解" }))
  };
  const trimmed = novelMemory.trimMemoryForPrompt(big);
  assert.ok(JSON.stringify(trimmed).length <= 4000, "注入长度要有硬上限，实际 " + JSON.stringify(trimmed).length);
  assert.equal(trimmed.characters.length <= 24, true, "列表按上限保留");
  assert.equal(trimmed.summary.length <= 1200, true, "摘要取尾部且不超上限");
  assert.match(trimmed.summary, /甲$/u, "摘要保留最后（最近）的部分");
  // 小记忆不受影响
  const small = novelMemory.normalizeMemory({ summary: "短", characters: ["甲"] });
  assert.deepEqual(novelMemory.trimMemoryForPrompt(small).characters, ["甲"]);
});

test("小说记忆总开关默认开、关掉后保持关（关掉＝请求里不再带记忆）", () => {
  assert.equal(normalizeRuntimeConfig({}).novelMemoryEnabled, true);
  assert.equal(normalizeRuntimeConfig({ novelMemoryEnabled: false }).novelMemoryEnabled, false);
});

test("novel UI contracts expose three icon-only grouped controls and independent image retry", () => {
  const controls = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "controls-triple.js"), "utf8"
  );
  const workflow = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "novel-workflow.js"), "utf8"
  );
  const progressiveWorkflow = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "novel-progressive-workflow.js"), "utf8"
  );
  const imageWorkflow = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "novel-image-workflow.js"), "utf8"
  );
  const workflowSources = `${workflow}\n${progressiveWorkflow}\n${imageWorkflow}`;
  const panel = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "novel-image-panel.js"), "utf8"
  );
  const dispatch = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "scene-dispatch.js"), "utf8"
  );
  const embedded = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "renderer-embed.js"), "utf8"
  );
  assert.match(controls, /append\(feedback, novelBall, comicBall, webpageBall\)/u);
  const position = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "floating-position.js"), "utf8"
  );
  assert.match(position, /persistSnappedPosition/u);
  assert.ok(
    position.indexOf("drag.moved = true") < position.indexOf("wrap.setPointerCapture?.(event.pointerId)"),
    "pointer capture must start only after the drag threshold so button clicks still fire"
  );
  assert.match(workflow, /void runtime\.translateNovelImages\(chapter\)/u);
  assert.match(workflowSources, /isolatedPage: true/u);
  assert.match(workflowSources, /renderMode: runtime\.RENDER_MODE_EMBEDDED/u);
  assert.match(workflowSources, /retryNovelImages/u);
  assert.match(workflow, /SAVE_NOVEL_MEMORY/u);
  assert.match(workflow, /memoryRevision/u);
  assert.match(progressiveWorkflow, /novelMemoryCore\.mergeMemory/u);
  assert.match(progressiveWorkflow, /正在逐段补齐/u);
  assert.match(panel, /getRenderedNovelImageLines/u);
  assert.match(panel, /reapplyNovelEmbeddedImages/u);
  assert.match(panel, /applyEmbeddedImageDataUrl/u);
  assert.match(panel, /图片译文/u);
  assert.match(dispatch, /isEmbeddedRenderMode\(\) \|\| novelImage/u);
  assert.match(embedded, /translatedLines/u);
});

test("floating actions are icon-driven and never switch function text labels", () => {
  const states = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "floating-states.js"), "utf8"
  );
  const actions = fs.readFileSync(
    path.join(root, "extension", "src", "shared", "floating-actions.js"), "utf8"
  );
  // 三个球统一从图标配置取资源，状态只能驱动角标/外圈/tooltip，不能替换主体图标。
  assert.match(actions, /novel: "assets\/floating-actions\//u);
  assert.match(actions, /comic: "assets\/floating-actions\//u);
  assert.match(actions, /webpage: "assets\/floating-actions\//u);
  assert.match(states, /AVAILABILITY = Object\.freeze\(\["enabled", "disabled", "detecting"\]\)/u);
  assert.match(states, /TASK_PHASE = Object\.freeze\(\["idle", "loading", "running", "error"\]\)/u);
  assert.match(states, /DISPLAY_MODE = Object\.freeze\(\["original", "translated"\]\)/u);
  assert.match(states, /CACHE_COVERAGE = Object\.freeze\(\["none", "partial", "full"\]\)/u);
  assert.match(states, /OVERLAY_VISIBILITY = Object\.freeze\(\["visible", "hidden"\]\)/u);
  assert.doesNotMatch(states, /textContent/u);
  // 状态通过 badge/tooltip/ariaLabel 表达，不通过修改按钮文字。
  assert.match(states, /badge: .*"check"/u);
  assert.match(states, /badge: "stop"/u);
  assert.match(states, /当前显示中文，点击恢复原文/u);
  assert.match(states, /漫画翻译运行中/u);
});

test("novel progress view explains ordered translation while the visible page is pending", () => {
  const view = buildNovelProgressView({
    textStatus: "working",
    imageStatus: "complete",
    progress: {
      textDone: 188,
      textTotal: 294,
      imageDone: 1,
      imageTotal: 1,
      textPhase: "正在精翻第 189–210 段…"
    }
  }, true);
  assert.equal(view.title, "小说精翻进行中");
  assert.equal(view.textPercent, 64);
  assert.equal(view.imagePercent, 100);
  assert.match(view.note, /当前页尚未轮到/u);
  const partial = buildNovelProgressView({
    textStatus: "partial",
    imageStatus: "complete",
    progress: {
      textDone: 288,
      textTotal: 294,
      textDiagnostic: "术语不一致 6 段"
    }
  });
  assert.match(partial.note, /诊断：术语不一致 6 段/u);
  const warned = buildNovelProgressView({
    textStatus: "complete",
    imageStatus: "complete",
    progress: {
      textDone: 294,
      textTotal: 294,
      textWarning: "已保留全部译文，其中 2 段未完全采用术语表指定译名。"
    }
  });
  assert.equal(warned.variant, "complete");
  assert.equal(warned.title, "小说翻译完成");
  assert.match(warned.note, /其中 2 段未完全采用术语表指定译名/u);
});
