import assert from "node:assert/strict";
import test from "node:test";
import states from "../extension/src/content/modules/floating-states.js";

const VALID_AVAILABILITY = new Set(states.AVAILABILITY);
const VALID_PHASES = new Set(states.TASK_PHASE);
const VALID_DISPLAY = new Set(states.DISPLAY_MODE);
const VALID_COVERAGE = new Set(states.CACHE_COVERAGE);
const VALID_OVERLAY = new Set(states.OVERLAY_VISIBILITY);

function assertValidState(state) {
  assert.ok(VALID_AVAILABILITY.has(state.availability), `availability ${state.availability}`);
  assert.ok(VALID_PHASES.has(state.phase), `phase ${state.phase}`);
  assert.ok(VALID_DISPLAY.has(state.displayMode), `displayMode ${state.displayMode}`);
  assert.ok(VALID_COVERAGE.has(state.cacheCoverage), `cacheCoverage ${state.cacheCoverage}`);
  if (state.id === "comic") assert.ok(VALID_OVERLAY.has(state.overlayVisibility), `overlayVisibility ${state.overlayVisibility}`);
}

test("novel: disabled and detecting stay distinct", () => {
  const disabled = states.buildNovelState({ enabled: true, kakaoReader: false });
  assert.equal(disabled.availability, "disabled");
  assert.match(disabled.availabilityReason, /未识别为 Kakao 小说页面/u);

  const off = states.buildNovelState({ enabled: false });
  assert.equal(off.availability, "disabled");
  assert.match(off.availabilityReason, /扩展已停用/u);

  const detecting = states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: false, surfaceSettled: false });
  assert.equal(detecting.availability, "detecting");
  assert.equal(detecting.phase, "idle");

  const noContent = states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: false, surfaceSettled: true });
  assert.equal(noContent.availability, "disabled");
  assert.match(noContent.availabilityReason, /未找到可翻译的小说正文/u);
  // detecting 与 disabled 的 presentation 不同：检测中有 spinner，无 badge
  const detectPresent = states.deriveFloatingActionPresentation("novel", detecting);
  assert.equal(detectPresent.spinner, true);
  assert.equal(detectPresent.badge, null);
  const disabledPresent = states.deriveFloatingActionPresentation("novel", disabled);
  assert.equal(disabledPresent.disabled, true);
  assert.equal(disabledPresent.spinner, false);
});

test("novel: original shown with none / partial / full cache coverage", () => {
  const base = { enabled: true, kakaoReader: true, surfaceFound: true, showTranslation: false };
  const none = states.buildNovelState({ ...base });
  assert.equal(none.cacheCoverage, "none");
  assert.equal(states.deriveFloatingActionPresentation("novel", none).badge, null);

  const partial = states.buildNovelState({ ...base, cacheStatus: "partial" });
  assert.equal(partial.cacheCoverage, "partial");
  const partialPresent = states.deriveFloatingActionPresentation("novel", partial);
  assert.equal(partialPresent.badge, "partial");
  assert.match(partialPresent.tooltip, /部分内容已有译文/u);

  const full = states.buildNovelState({ ...base, cacheStatus: "cached" });
  assert.equal(full.cacheCoverage, "full");
  const fullPresent = states.deriveFloatingActionPresentation("novel", full);
  assert.equal(fullPresent.badge, "cache");
  assert.match(fullPresent.tooltip, /缓存已有完整译文/u);
});

test("novel: translated shown, including translated + partial failure", () => {
  const shown = states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, textStatus: "complete", showTranslation: true });
  assert.equal(shown.displayMode, "translated");
  assert.equal(shown.phase, "idle");
  const check = states.deriveFloatingActionPresentation("novel", shown);
  assert.equal(check.badge, "check");
  assert.match(check.tooltip, /当前显示中文，点击恢复原文/u);

  const partialFail = states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, textStatus: "partial", showTranslation: true });
  assert.equal(partialFail.displayMode, "translated");
  assert.equal(partialFail.phase, "error");
  assert.equal(partialFail.cacheCoverage, "partial");
  const partialBadge = states.deriveFloatingActionPresentation("novel", partialFail);
  assert.equal(partialBadge.badge, "partial");
  assert.match(partialBadge.tooltip, /部分段落翻译失败，已显示的中文译文保留/u);

  const failedOriginal = states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, textStatus: "partial", showTranslation: false, errorMessage: "API 请求失败" });
  const errorPresent = states.deriveFloatingActionPresentation("novel", failedOriginal);
  assert.equal(errorPresent.badge, "error");
  assert.match(errorPresent.tooltip, /API 请求失败/u);
});

test("novel: loading phase shows spinner without badge", () => {
  const loading = states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, textStatus: "working", showTranslation: false });
  assert.equal(loading.phase, "loading");
  const present = states.deriveFloatingActionPresentation("novel", loading);
  assert.equal(present.spinner, true);
  assert.equal(present.badge, null);
});

test("comic: running and overlay-hidden are expressed simultaneously", () => {
  const running = states.buildComicState({ enabled: true, running: true, overlayVisible: true });
  assert.equal(running.phase, "running");
  assert.equal(running.overlayVisibility, "visible");
  const runningPresent = states.deriveFloatingActionPresentation("comic", running);
  assert.equal(runningPresent.runningRing, true);
  assert.equal(runningPresent.badge, "stop");
  assert.match(runningPresent.tooltip, /漫画翻译运行中/u);

  const runningHidden = states.buildComicState({ enabled: true, running: true, overlayVisible: false });
  assert.equal(runningHidden.phase, "running");
  assert.equal(runningHidden.overlayVisibility, "hidden");
  const hiddenPresent = states.deriveFloatingActionPresentation("comic", runningHidden);
  assert.equal(hiddenPresent.badge, "stop");
  assert.match(hiddenPresent.tooltip, /覆盖层已隐藏/u);

  // 已停止但覆盖层仍然显示
  const stopped = states.buildComicState({ enabled: true, running: false, overlayVisible: true });
  assert.equal(stopped.phase, "idle");
  assert.equal(stopped.overlayVisibility, "visible");
  assert.equal(states.deriveFloatingActionPresentation("comic", stopped).badge, null);

  // 覆盖层隐藏（未运行）→ hidden 角标
  const hiddenIdle = states.buildComicState({ enabled: true, running: false, overlayVisible: false });
  assert.equal(states.deriveFloatingActionPresentation("comic", hiddenIdle).badge, "hidden");
});

test("comic: loading while processing the current viewport", () => {
  const loading = states.buildComicState({ enabled: true, running: false, working: true });
  assert.equal(loading.phase, "loading");
  const present = states.deriveFloatingActionPresentation("comic", loading);
  assert.equal(present.spinner, true);
  assert.equal(present.runningRing, false);
});

test("webpage: continuous + translated keeps both axes while new content translates", () => {
  const active = states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "translated", working: false,
    viewportTotal: 5, viewportDone: 5
  });
  assert.equal(active.displayMode, "translated");
  assert.equal(active.phase, "idle");
  assert.equal(active.viewportReady, true);
  assert.equal(states.deriveFloatingActionPresentation("webpage", active).badge, "check");

  const activeLoadingNew = states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "translated", working: true,
    viewportTotal: 5, viewportDone: 2
  });
  assert.equal(activeLoadingNew.displayMode, "translated");
  assert.equal(activeLoadingNew.phase, "loading");
  const present = states.deriveFloatingActionPresentation("webpage", activeLoadingNew);
  assert.equal(present.spinner, true);
  assert.equal(present.badge, null);
  assert.match(present.tooltip, /正在翻译当前可视区/u);
});

test("webpage: viewport ready with background still working shows background progress", () => {
  const state = states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "translated", working: true,
    viewportTotal: 5, viewportDone: 5, backgroundTotal: 20, backgroundDone: 9
  });
  assert.equal(state.phase, "loading");
  const present = states.deriveFloatingActionPresentation("webpage", state);
  assert.equal(present.spinner, true);
  assert.equal(present.badge, "check");
  assert.match(present.tooltip, /可视区已准备 5\/5，后台继续翻译/u);
});

test("webpage: real failures after translation show partial badge", () => {
  const partialFail = states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "translated", realFailed: 2,
    viewportTotal: 5, viewportDone: 5
  });
  assert.equal(partialFail.phase, "error");
  assert.equal(partialFail.displayMode, "translated");
  const present = states.deriveFloatingActionPresentation("webpage", partialFail);
  assert.equal(present.badge, "partial");
  assert.match(present.tooltip, /部分内容失败/u);
});

test("webpage: service offline is a page-level fault, not per-item failure", () => {
  const offline = states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "translated", pageFault: { error: "本地服务未启动" },
    viewportTotal: 5, viewportDone: 5
  });
  assert.equal(offline.phase, "error");
  assert.equal(offline.displayMode, "translated");
  const present = states.deriveFloatingActionPresentation("webpage", offline);
  assert.equal(present.badge, "partial");
  assert.match(present.tooltip, /本地服务未启动/u);
});

test("webpage: showing source keeps continuous mode with no badge", () => {
  const state = states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "source", working: false,
    viewportTotal: 5, viewportDone: 5, backgroundTotal: 20, backgroundDone: 20
  });
  assert.equal(state.displayMode, "original");
  assert.equal(state.continuous, true);
  const present = states.deriveFloatingActionPresentation("webpage", state);
  assert.equal(present.badge, null);
  assert.match(present.tooltip, /显示原文，持续翻译仍开启，点击重新显示译文/u);
});

test("webpage: cache coverage drives off-mode badge", () => {
  const base = { enabled: true, mode: "off" };
  assert.equal(states.deriveFloatingActionPresentation("webpage", states.buildWebpageState({ ...base })).badge, null);
  assert.equal(states.deriveFloatingActionPresentation("webpage", states.buildWebpageState({ ...base, cacheStatus: "partial" })).badge, "partial");
  assert.equal(states.deriveFloatingActionPresentation("webpage", states.buildWebpageState({ ...base, cacheStatus: "cached" })).badge, "cache");
});

test("every derived state is valid and every presentation has aria-label and tooltip", () => {
  const cases = [
    states.buildNovelState({ enabled: true, kakaoReader: false }),
    states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: false, surfaceSettled: false }),
    states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true }),
    states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, cacheStatus: "partial" }),
    states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, cacheStatus: "cached" }),
    states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, textStatus: "working" }),
    states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, textStatus: "complete", showTranslation: true }),
    states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, textStatus: "partial", showTranslation: true }),
    states.buildComicState({ enabled: true }),
    states.buildComicState({ enabled: true, working: true }),
    states.buildComicState({ enabled: true, running: true }),
    states.buildComicState({ enabled: true, running: true, overlayVisible: false }),
    states.buildComicState({ enabled: false }),
    states.buildWebpageState({ enabled: true, mode: "off" }),
    states.buildWebpageState({ enabled: true, mode: "off", cacheStatus: "partial" }),
    states.buildWebpageState({ enabled: true, mode: "off", cacheStatus: "cached" }),
    states.buildWebpageState({ enabled: true, mode: "continuous", visibility: "source", working: true }),
    states.buildWebpageState({ enabled: true, mode: "continuous", visibility: "translated" }),
    states.buildWebpageState({ enabled: true, mode: "continuous", visibility: "translated", working: true, viewportTotal: 5, viewportDone: 3 }),
    states.buildWebpageState({ enabled: true, mode: "continuous", visibility: "translated", realFailed: 1 }),
    states.buildWebpageState({ enabled: true, mode: "continuous", visibility: "source", pageFault: { error: "离线" } }),
    states.buildWebpageState({ enabled: false })
  ];
  for (const state of cases) {
    assertValidState(state);
    const presentation = states.deriveFloatingActionPresentation(state.id, state);
    assert.equal(typeof presentation.tooltip, "string");
    assert.ok(presentation.tooltip.length > 0);
    assert.equal(typeof presentation.ariaLabel, "string");
    assert.ok(presentation.ariaLabel.length > 0);
    assert.equal(typeof presentation.disabled, "boolean");
    assert.equal(typeof presentation.spinner, "boolean");
    assert.equal(typeof presentation.runningRing, "boolean");
  }
});

test("novel menu exposes chapter actions and marks future features as disabled", () => {
  const idle = states.buildNovelMenuItems(states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true }));
  assert.deepEqual(idle.map(item => item.id), [
    "translate-chapter", "translate-missing", "show-translation",
    "restore-original", "force-retranslate", "retranslate-text", "retranslate-images", "manage-chapter"
  ]);
  const manage = idle.find(item => item.id === "manage-chapter");
  assert.equal(manage.disabled, true);
  assert.match(manage.disabledReason, /没有可管理的译文/u);
  assert.equal(idle.find(item => item.id === "force-retranslate").disabled, false);
  assert.equal(idle.find(item => item.id === "retranslate-text").disabled, false);
  assert.equal(idle.find(item => item.id === "retranslate-images").disabled, false);
  const shown = states.buildNovelMenuItems(states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, textStatus: "complete", showTranslation: true }));
  assert.equal(shown.find(item => item.id === "restore-original").disabled, false);
  assert.equal(shown.find(item => item.id === "translate-chapter").disabled, true);
  const busy = states.buildNovelMenuItems(states.buildNovelState({ enabled: true, kakaoReader: true, surfaceFound: true, imageStatus: "working" }));
  assert.equal(busy.find(item => item.id === "retranslate-images").disabled, true);
  assert.match(busy.find(item => item.id === "retranslate-images").disabledReason, /图片正在处理中/u);
});

test("comic menu separates stop, hide overlay and clear overlay", () => {
  const running = states.buildComicMenuItems(states.buildComicState({ enabled: true, running: true, overlayVisible: true }));
  assert.deepEqual(running.map(item => item.id), [
    "translate-viewport", "start-continuous", "stop-continuous",
    "show-overlay", "hide-overlay", "clear-overlay"
  ]);
  assert.equal(running.find(item => item.id === "stop-continuous").disabled, false);
  assert.equal(running.find(item => item.id === "start-continuous").disabled, true);
  assert.equal(running.find(item => item.id === "hide-overlay").disabled, false);
  const hidden = states.buildComicMenuItems(states.buildComicState({ enabled: true, running: true, overlayVisible: false }));
  assert.equal(hidden.find(item => item.id === "show-overlay").disabled, false);
  assert.equal(hidden.find(item => item.id === "hide-overlay").disabled, true);
});

test("webpage menu keeps selection translation as a reserved entry", () => {
  const items = states.buildWebpageMenuItems(states.buildWebpageState({ enabled: true, mode: "off" }));
  assert.deepEqual(items.map(item => item.id), [
    "translate-page", "restore-page", "stop-continuous", "retry-failed", "retranslate-all", "translate-selection"
  ]);
  assert.equal(items.find(item => item.id === "retry-failed").disabled, true, "无失败段时重试失败不可用");
  const selection = items.find(item => item.id === "translate-selection");
  assert.equal(selection.disabled, true);
  assert.match(selection.disabledReason, /后续版本/u);
  const shown = states.buildWebpageMenuItems(states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "translated",
    viewportTotal: 5, viewportDone: 5
  }));
  assert.equal(shown.find(item => item.id === "restore-page").disabled, false);
  assert.equal(shown.find(item => item.id === "translate-page").disabled, true);
  const stopped = states.buildWebpageMenuItems(states.buildWebpageState({
    enabled: true, mode: "off", visibility: "source"
  }));
  assert.equal(stopped.find(item => item.id === "stop-continuous").disabled, true);
  const sourceMode = states.buildWebpageMenuItems(states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "source"
  }));
  assert.equal(sourceMode.find(item => item.id === "stop-continuous").disabled, false);
  assert.equal(sourceMode.find(item => item.id === "translate-page").disabled, false);
});

test("badge svg set covers every badge type", () => {
  for (const badge of ["check", "stop", "partial", "cache", "visible", "hidden", "error"]) {
    assert.ok(states.BADGE_SVG[badge], `badge svg missing for ${badge}`);
    assert.match(states.BADGE_SVG[badge], /<svg/u);
  }
});

// ── Refresh / cache-coverage vs display-mode distinction ──

test("webpage: refresh with full cache shows cache badge, never check", () => {
  // 刷新后：模式关闭、页面显示原文，但 IndexedDB 有完整缓存
  const state = states.buildWebpageState({ enabled: true, mode: "off", cacheStatus: "cached" });
  assert.equal(state.displayMode, "original");
  assert.equal(state.cacheCoverage, "full");
  const present = states.deriveFloatingActionPresentation("webpage", state);
  assert.equal(present.badge, "cache");
  assert.notEqual(present.badge, "check");
  assert.match(present.tooltip, /已有本地译文，点击开启持续翻译并显示/u);
  assert.equal(present.spinner, false);
});

test("webpage: refresh with partial cache shows partial badge, never check", () => {
  // 刷新后：模式关闭、页面显示原文，部分内容有缓存
  const state = states.buildWebpageState({ enabled: true, mode: "off", cacheStatus: "partial" });
  assert.equal(state.displayMode, "original");
  assert.equal(state.cacheCoverage, "partial");
  const present = states.deriveFloatingActionPresentation("webpage", state);
  assert.equal(present.badge, "partial");
  assert.notEqual(present.badge, "check");
  assert.match(present.tooltip, /部分内容已有译文，点击开启持续翻译并补全/u);
});

test("webpage: translated with full cache shows check badge, not cache", () => {
  // 页面已显示译文，缓存完整
  const state = states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "translated", cacheStatus: "cached",
    viewportTotal: 3, viewportDone: 3
  });
  assert.equal(state.displayMode, "translated");
  assert.equal(state.cacheCoverage, "full");
  const present = states.deriveFloatingActionPresentation("webpage", state);
  assert.equal(present.badge, "check");
  assert.match(present.tooltip, /当前页面翻译完成，点击恢复原文/u);
});

test("webpage: showing source after translated keeps cache coverage, drops check", () => {
  // 翻译后点击显示原文：displayMode 回到 original，cacheCoverage 仍为 full
  const state = states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "source", cacheStatus: "cached"
  });
  assert.equal(state.displayMode, "original");
  assert.equal(state.cacheCoverage, "full");
  const present = states.deriveFloatingActionPresentation("webpage", state);
  // 不显示对勾，也不显示缓存角标——持续模式显示原文是独立状态
  assert.notEqual(present.badge, "check");
  assert.match(present.tooltip, /显示原文，持续翻译仍开启/u);
});

test("webpage: refresh lifecycle — initial state before cache analysis", () => {
  // 模拟刷新后、缓存分析完成前：模式关闭、cacheStatus="none"
  const state = states.buildWebpageState({ enabled: true, mode: "off", cacheStatus: "none" });
  assert.equal(state.displayMode, "original");
  assert.equal(state.cacheCoverage, "none");
  assert.equal(state.phase, "idle");
  const present = states.deriveFloatingActionPresentation("webpage", state);
  assert.equal(present.badge, null);
  assert.equal(present.spinner, false);
  assert.equal(present.disabled, false);
  assert.match(present.tooltip, /点击开启持续翻译并显示译文/u);
});

test("webpage: disabled state always shows original with no badge", () => {
  const state = states.buildWebpageState({ enabled: false });
  assert.equal(state.displayMode, "original");
  assert.equal(state.cacheCoverage, "none");
  const present = states.deriveFloatingActionPresentation("webpage", state);
  assert.equal(present.badge, null);
  assert.equal(present.disabled, true);
});

// ── Invariant: check badge requires displayMode === "translated" ──

test("webpage: check badge never appears when displayMode is original", () => {
  // 穷举 displayMode=original 的所有组合，验证不出现 check 角标
  const combinations = [
    { mode: "off", cacheStatus: "none" },
    { mode: "off", cacheStatus: "partial" },
    { mode: "off", cacheStatus: "cached" },
    { mode: "continuous", visibility: "source", working: true },
    { mode: "continuous", visibility: "source", realFailed: 1 },
    { mode: "off", cacheStatus: "cached", working: true },
  ];
  for (const ctx of combinations) {
    const state = states.buildWebpageState({ enabled: true, ...ctx });
    assert.equal(state.displayMode, "original", `displayMode should be original for ${JSON.stringify(ctx)}`);
    const present = states.deriveFloatingActionPresentation("webpage", state);
    assert.notEqual(present.badge, "check", `badge should not be "check" for ${JSON.stringify(ctx)}, got "${present.badge}"`);
  }
});

test("webpage: displayMode=translated with phase=error shows partial badge", () => {
  // 翻译完成但有部分失败：显示译文 + partial 角标
  const state = states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "translated", realFailed: 1,
    viewportTotal: 5, viewportDone: 5
  });
  assert.equal(state.displayMode, "translated");
  assert.equal(state.phase, "error");
  const present = states.deriveFloatingActionPresentation("webpage", state);
  assert.equal(present.badge, "partial");
  assert.match(present.tooltip, /部分内容失败/u);
});

test("webpage: loading while original shows spinner without check", () => {
  // 持续翻译进行中 + 显示原文 → spinner，无 check
  const state = states.buildWebpageState({
    enabled: true, mode: "continuous", visibility: "source", working: true
  });
  assert.equal(state.displayMode, "original");
  assert.equal(state.phase, "loading");
  const present = states.deriveFloatingActionPresentation("webpage", state);
  assert.equal(present.spinner, true);
  assert.equal(present.badge, null);
  assert.match(present.tooltip, /显示原文，后台持续翻译中/u);
});
