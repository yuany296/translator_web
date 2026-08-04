/**
 * Orthogonal state model for the three floating actions (novel / comic /
 * webpage). Concerns are kept separate so combinations stay expressible:
 *   availability  - enabled / disabled / detecting
 *   phase         - idle / loading / running / error
 *   displayMode   - original / translated
 *   cacheCoverage - none / partial / full
 *   overlay       - visible / hidden (comic only)
 *
 * build*State() are pure snapshot builders; deriveFloatingActionPresentation()
 * derives the visual presentation (spinner / ring / badge / tooltip / aria)
 * from the state. No module decides badges or tooltips by hand.
 */

const AVAILABILITY = Object.freeze(["enabled", "disabled", "detecting"]);
const TASK_PHASE = Object.freeze(["idle", "loading", "running", "error"]);
const DISPLAY_MODE = Object.freeze(["original", "translated"]);
const CACHE_COVERAGE = Object.freeze(["none", "partial", "full"]);
const OVERLAY_VISIBILITY = Object.freeze(["visible", "hidden"]);

const BADGE_SVG = Object.freeze({
  check: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1.6 5.4 4.2 8l4.4-6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stop: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="1.6" y="1.6" width="6.8" height="6.8" rx="1.2" fill="#fff"/></svg>',
  partial: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="4.5 4" transform="rotate(-90 5 5)"/></svg>',
  cache: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><ellipse cx="5" cy="2.4" rx="3.4" ry="1.5" fill="#fff"/><path d="M1.6 2.4v5.2c0 .8 1.5 1.5 3.4 1.5s3.4-.7 3.4-1.5V2.4" fill="none" stroke="#fff" stroke-width="1.3"/><path d="M1.6 5c0 .8 1.5 1.5 3.4 1.5s3.4-.7 3.4-1.5" fill="none" stroke="#fff" stroke-width="1.3"/></svg>',
  error: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M5 1.2 9.2 8.6H.8Z" fill="#fff"/><path d="M5 3.8v2" stroke="#c62828" stroke-width="1.2" stroke-linecap="round"/><circle cx="5" cy="7" r="0.7" fill="#c62828"/></svg>',
  visible: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1 5c1.6-2.2 3.1-3.2 4-3.2S7.4 2.8 9 5c-1.6 2.2-3.1 3.2-4 3.2S2.6 7.2 1 5Z" fill="none" stroke="#fff" stroke-width="1.2"/><circle cx="5" cy="5" r="1.4" fill="#fff"/></svg>',
  hidden: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1 5c1.6-2.2 3.1-3.2 4-3.2S7.4 2.8 9 5c-1.6 2.2-3.1 3.2-4 3.2S2.6 7.2 1 5Z" fill="none" stroke="#fff" stroke-width="1.2"/><path d="M2 8.2 8 1.8" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>'
});

function joinTooltip(title, detail) {
  return detail ? `${title}\n${detail}` : title;
}

function toAriaLabel(tooltip) {
  return String(tooltip || "").replace(/\n/gu, "，").replace(/\s+/gu, " ").trim();
}

function disabledState(id, reason) {
  return {
    id,
    availability: "disabled",
    availabilityReason: reason,
    phase: "idle",
    displayMode: "original",
    cacheCoverage: "none",
    overlayVisibility: "visible"
  };
}

function buildNovelState(ctx = {}) {
  const enabled = ctx.enabled !== false && !ctx.invalidated;
  if (!enabled) return disabledState("novel", "扩展已停用或页面上下文已失效");
  if (!ctx.kakaoReader) return disabledState("novel", "当前页面未识别为 Kakao 小说页面");
  if (!ctx.surfaceFound) {
    if (ctx.surfaceSettled !== true) {
      return { id: "novel", availability: "detecting", availabilityReason: "", phase: "idle", displayMode: "original", cacheCoverage: "none" };
    }
    return disabledState("novel", "当前页面未找到可翻译的小说正文");
  }
  const coverage = ctx.cacheStatus === "cached" ? "full" : ctx.cacheStatus === "partial" ? "partial" : "none";
  return {
    id: "novel",
    availability: "enabled",
    availabilityReason: "",
    phase: ctx.textStatus === "working" ? "loading" : ctx.textStatus === "partial" ? "error" : "idle",
    displayMode: ctx.showTranslation ? "translated" : "original",
    cacheCoverage: ctx.textStatus === "complete" ? "full" : ctx.textStatus === "partial" ? "partial" : coverage,
    hasTranslation: ctx.translatedCount > 0 || ctx.textStatus === "complete",
    errorMessage: String(ctx.errorMessage || "")
  };
}

function buildComicState(ctx = {}) {
  const enabled = ctx.enabled !== false && !ctx.invalidated;
  if (!enabled) return disabledState("comic", "扩展已停用或页面上下文已失效");
  const running = ctx.running === true;
  const working = ctx.working === true;
  return {
    id: "comic",
    availability: "enabled",
    availabilityReason: "",
    phase: running ? "running" : working ? "loading" : "idle",
    displayMode: "original",
    cacheCoverage: "none",
    overlayVisibility: ctx.overlayVisible === false ? "hidden" : "visible"
  };
}

function buildWebpageState(ctx = {}) {
  const enabled = ctx.enabled !== false && !ctx.invalidated;
  if (!enabled) return disabledState("webpage", "扩展已停用或页面上下文已失效");
  const continuous = ctx.mode === "continuous";
  const coverage = ctx.cacheStatus === "cached" ? "full" : ctx.cacheStatus === "partial" ? "partial" : "none";
  const viewportReady = ctx.viewportTotal > 0 && ctx.viewportDone >= ctx.viewportTotal;
  const backgroundBusy = ctx.queueBusy === true || ctx.working === true;
  let phase = "idle";
  if (ctx.working) phase = "loading";
  else if (ctx.pageFault) phase = "error";
  else if (ctx.realFailed > 0) phase = "error";
  else if (continuous && backgroundBusy) phase = "loading";
  return {
    id: "webpage",
    availability: "enabled",
    availabilityReason: "",
    phase,
    displayMode: continuous && ctx.visibility === "translated" ? "translated" : "original",
    cacheCoverage: coverage,
    continuous,
    viewportReady,
    viewportTotal: ctx.viewportTotal,
    viewportDone: ctx.viewportDone,
    backgroundTotal: ctx.backgroundTotal,
    backgroundDone: ctx.backgroundDone,
    pendingSave: ctx.pendingSave,
    hasTranslation: ctx.viewportDone > 0 || ctx.backgroundDone > 0,
    errorMessage: String(ctx.errorMessage || (ctx.pageFault && ctx.pageFault.error) || "")
  };
}

function presentNovel(state) {
  if (state.availability === "disabled") {
    return { disabled: true, spinner: false, runningRing: false, badge: null, tooltip: joinTooltip("小说翻译不可用", state.availabilityReason), ariaLabel: toAriaLabel(joinTooltip("小说翻译不可用", state.availabilityReason)) };
  }
  if (state.availability === "detecting") {
    const tooltip = joinTooltip("小说翻译", "正在检测小说页面…");
    return { disabled: false, spinner: true, runningRing: false, badge: null, tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  if (state.phase === "loading") {
    const tooltip = joinTooltip("小说翻译中…", "译文将按章节顺序显示，请稍候");
    return { disabled: false, spinner: true, runningRing: false, badge: null, tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  if (state.displayMode === "translated") {
    const tooltip = state.phase === "error"
      ? joinTooltip("小说翻译", "部分段落翻译失败，已显示的中文译文保留")
      : joinTooltip("小说翻译", "当前显示中文，点击恢复原文");
    return { disabled: false, spinner: false, runningRing: false, badge: state.phase === "error" ? "partial" : "check", tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  if (state.phase === "error") {
    const tooltip = joinTooltip("小说翻译失败", state.errorMessage || "部分段落未翻译完成");
    return { disabled: false, spinner: false, runningRing: false, badge: "error", tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  if (state.cacheCoverage === "full") {
    const tooltip = joinTooltip("小说翻译", "缓存已有完整译文，点击显示中文");
    return { disabled: false, spinner: false, runningRing: false, badge: "cache", tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  if (state.cacheCoverage === "partial") {
    const tooltip = joinTooltip("小说翻译", "部分内容已有译文，点击后翻译缺失内容");
    return { disabled: false, spinner: false, runningRing: false, badge: "partial", tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  const tooltip = joinTooltip("小说翻译", "点击显示中文译文");
  return { disabled: false, spinner: false, runningRing: false, badge: null, tooltip, ariaLabel: toAriaLabel(tooltip) };
}

function presentComic(state) {
  if (state.availability === "disabled") {
    return { disabled: true, spinner: false, runningRing: false, badge: null, tooltip: joinTooltip("漫画翻译不可用", state.availabilityReason), ariaLabel: toAriaLabel(joinTooltip("漫画翻译不可用", state.availabilityReason)) };
  }
  if (state.phase === "running") {
    const overlayNote = state.overlayVisibility === "hidden" ? "，覆盖层已隐藏" : "";
    const tooltip = joinTooltip(`漫画翻译运行中${overlayNote}`, "点击停止");
    return { disabled: false, spinner: false, runningRing: true, badge: "stop", tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  if (state.phase === "loading") {
    const tooltip = joinTooltip("漫画翻译处理中…", "请稍候");
    return { disabled: false, spinner: true, runningRing: false, badge: null, tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  if (state.overlayVisibility === "hidden") {
    const tooltip = joinTooltip("漫画翻译", "译文覆盖层已隐藏，点击开始连续翻译");
    return { disabled: false, spinner: false, runningRing: false, badge: "hidden", tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  const tooltip = joinTooltip("漫画翻译", "点击开始连续翻译，已显示的覆盖层保留");
  return { disabled: false, spinner: false, runningRing: false, badge: null, tooltip, ariaLabel: toAriaLabel(tooltip) };
}

function presentWebpage(state) {
  if (state.availability === "disabled") {
    return { disabled: true, spinner: false, runningRing: false, badge: null, tooltip: joinTooltip("网页翻译不可用", state.availabilityReason), ariaLabel: toAriaLabel(joinTooltip("网页翻译不可用", state.availabilityReason)) };
  }
  if (!state.continuous) {
    const tooltip = state.cacheCoverage === "full"
      ? joinTooltip("网页翻译", "已有本地译文，点击开启持续翻译并显示")
      : state.cacheCoverage === "partial"
        ? joinTooltip("网页翻译", "部分内容已有译文，点击开启持续翻译并补全")
        : joinTooltip("网页翻译", "点击开启持续翻译并显示译文");
    return { disabled: false, spinner: false, runningRing: false, badge: state.cacheCoverage === "full" ? "cache" : state.cacheCoverage === "partial" ? "partial" : null, tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  if (state.phase === "loading") {
    const busyBackground = state.viewportReady;
    const tooltip = state.displayMode === "translated"
      ? (busyBackground ? joinTooltip("网页翻译中…", `可视区已准备 ${state.viewportDone}/${state.viewportTotal}，后台继续翻译`) : joinTooltip("网页翻译中…", "正在翻译当前可视区"))
      : joinTooltip("网页翻译中…", "显示原文，后台持续翻译中");
    return { disabled: false, spinner: true, runningRing: false, badge: state.displayMode === "translated" && state.viewportReady ? "check" : null, tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  if (state.displayMode === "translated") {
    const complete = state.viewportReady && state.phase !== "error";
    const errorNote = state.pendingSave > 0 ? `，待保存 ${state.pendingSave} 条`
      : state.realFailed > 0 ? `，${state.realFailed} 条失败`
        : state.errorMessage ? `（${state.errorMessage}）` : "";
    const tooltip = state.phase === "error"
      ? joinTooltip("网页翻译", `部分内容失败${errorNote}，点击恢复原文`)
      : complete
        ? joinTooltip("网页翻译", "当前页面翻译完成，点击恢复原文")
        : joinTooltip("网页翻译", `当前显示中文${state.backgroundTotal ? `，后台 ${state.backgroundDone}/${state.backgroundTotal}` : ""}，点击恢复原文`);
    return { disabled: false, spinner: false, runningRing: false, badge: state.phase === "error" ? "partial" : "check", tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  if (state.phase === "error") {
    const tooltip = joinTooltip("网页翻译", state.errorMessage || "翻译失败，请重试");
    return { disabled: false, spinner: false, runningRing: false, badge: "error", tooltip, ariaLabel: toAriaLabel(tooltip) };
  }
  // 持续模式 + 显示原文
  const tooltip = joinTooltip("网页翻译", "显示原文，持续翻译仍开启，点击重新显示译文");
  return { disabled: false, spinner: false, runningRing: false, badge: null, tooltip, ariaLabel: toAriaLabel(tooltip) };
}

function deriveFloatingActionPresentation(id, state) {
  switch (id) {
    case "novel":
      return presentNovel(state);
    case "comic":
      return presentComic(state);
    case "webpage":
      return presentWebpage(state);
    default:
      return { disabled: true, spinner: false, runningRing: false, badge: null, tooltip: "", ariaLabel: "" };
  }
}

function buildNovelMenuItems(state = {}) {
  const loading = state.phase === "loading";
  const translated = state.displayMode === "translated";
  const error = state.phase === "error";
  const list = [
    { id: "translate-chapter", label: "翻译当前章节", disabled: loading || translated },
    { id: "translate-missing", label: "只翻译缺失段落", disabled: loading || (translated && !error) },
    { id: "show-translation", label: "显示译文", disabled: !(state.hasTranslation === true && !translated), disabledReason: state.hasTranslation ? "" : "当前没有已翻译的段落" },
    { id: "restore-original", label: "恢复原文", disabled: !translated, disabledReason: translated ? "" : "当前已显示原文" },
    { id: "force-retranslate", label: "强制重新翻译当前章节", disabled: loading }
  ];
  list.push({
    id: "manage-chapter",
    label: "管理当前章节译文",
    disabled: loading || state.hasTranslation !== true,
    disabledReason: state.hasTranslation ? "" : "当前没有可管理的译文"
  });
  return list;
}

function buildComicMenuItems(state = {}) {
  const running = state.phase === "running";
  const loading = state.phase === "loading";
  const overlayVisible = state.overlayVisibility !== "hidden";
  return [
    { id: "translate-viewport", label: "翻译当前视口", disabled: loading },
    { id: "start-continuous", label: "开始连续翻译", disabled: running || loading },
    { id: "stop-continuous", label: "停止连续翻译", disabled: !running },
    { id: "show-overlay", label: "显示译文覆盖层", disabled: overlayVisible },
    { id: "hide-overlay", label: "隐藏译文覆盖层", disabled: !overlayVisible },
    { id: "clear-overlay", label: "清除当前页面覆盖层", disabled: false }
  ];
}

function buildWebpageMenuItems(state = {}) {
  const loading = state.phase === "loading";
  const translated = state.displayMode === "translated";
  const continuous = state.continuous === true;
  const list = [
    { id: "translate-page", label: continuous ? "重新显示译文" : "开启持续翻译并显示", disabled: loading || translated || (continuous && state.hasTranslation && translated), disabledReason: translated ? "当前已显示译文" : "" },
    { id: "restore-page", label: "显示原文", disabled: loading || !translated, disabledReason: translated ? "" : "当前已显示原文" },
    { id: "stop-continuous", label: "停止持续翻译", disabled: !continuous || loading, disabledReason: continuous ? "" : "当前未开启持续翻译" },
    { id: "force-update", label: "强制更新网页翻译", disabled: loading }
  ];
  list.push({
    id: "translate-selection",
    label: "翻译选中文字",
    disabled: true,
    disabledReason: "选中文字翻译将在后续版本提供"
  });
  return list;
}

export default Object.freeze({
  AVAILABILITY,
  TASK_PHASE,
  DISPLAY_MODE,
  CACHE_COVERAGE,
  OVERLAY_VISIBILITY,
  BADGE_SVG,
  buildNovelState,
  buildComicState,
  buildWebpageState,
  deriveFloatingActionPresentation,
  buildNovelMenuItems,
  buildComicMenuItems,
  buildWebpageMenuItems,
  joinTooltip,
  toAriaLabel
});
