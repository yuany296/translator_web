import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import glossary from "../extension/src/shared/glossary.js";
import novel from "../extension/src/shared/novel.js";
import novelMemory from "../extension/src/shared/novel-memory.js";
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

test("novel UI contracts expose three icon-only grouped controls and independent image retry", () => {
  const controls = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "controls-triple.js"), "utf8"
  );
  const workflow = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "novel-workflow.js"), "utf8"
  );
  const imageWorkflow = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "novel-image-workflow.js"), "utf8"
  );
  const workflowSources = `${workflow}\n${imageWorkflow}`;
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
  assert.match(workflow, /novelMemoryCore\.mergeMemory/u);
  assert.match(workflow, /正在逐段补齐/u);
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
