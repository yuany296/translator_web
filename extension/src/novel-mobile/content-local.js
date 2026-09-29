/**
 * 手机版内容脚本覆盖层。
 *
 * 章节翻译原本是 novel-workflow.js 里的闭包（translateNovelText / translateNovelChapter），
 * 只能整体替换。桌面版那条链路先检查本地服务、再试流式接口、最后才直连 LLM；手机上没有
 * 本地服务，这里直接走「本地缓存 + 并发小批直连 LLM」，其余校验（术语一致、对话引号、
 * 漏段补救、段落身份防串号）继续复用现有实现，不做任何复制。
 *
 * 并发小批见 novel-batch.js：桌面版的渐进小批是串行等每一块返回，一屏要等好几分钟。
 */
import { installNovelBatch } from "./novel-batch.js";
import { installMobileProgressLabels } from "./progress-labels.js";

const NOVEL_STATUS_WORKING = "working";

function getTranslatableParagraphs(runtime, chapter) {
  const targetLanguage = runtime.getTargetLanguage?.() || "zh-CN";
  return (chapter.paragraphs || []).filter(item => {
    const sourceLanguage = runtime.resolveSourceLanguage?.(item.original_text) || "auto";
    return String(item.original_text || "").trim()
      && (sourceLanguage === "auto" || sourceLanguage !== targetLanguage);
  });
}

/**
 * 把译文贴回页面并统一可见性。
 *
 * 必须按**当前** surface 重贴一遍，不能只依赖 applyChunk 里那次渲染：段落节点是在点击那一刻
 * 抓取的，而 LLM 要十几秒才回来，KakaoPage 的虚拟滚动/EPUB 重渲染完全可能在这中间把节点换掉。
 * 换掉之后 renderNovelTranslation 写进的是脱离文档的旧节点 —— 译文进了 state 和缓存、进度显示
 * 完成，页面上却还是韩文。reconcileNovelReader 会把 state.surface 刷成当前宿主，
 * reapplyNovelTranslations 再按段落 id 找活节点重贴。
 */
function revealTranslations(runtime, chapter) {
  const surface = runtime.reconcileNovelReader?.() || runtime.findNovelSurface?.() || chapter.surface;
  runtime.reapplyNovelTranslations?.(surface);
  runtime.setNovelTranslationVisibility(true);
  return surface;
}

/**
 * 本屏译文到齐后统一的两个收尾动作：术语发现 + 「让模型排版」对齐。
 * 两者都只对「本屏真的翻出来了」的段落做事，失败都不该影响翻译本身。
 */
function afterScreenTranslated(runtime, chapter) {
  if (!chapter) return;
  void runtime.scheduleNovelTermDiscovery?.(chapter);
  void Promise.resolve(runtime.alignNovelEmphasisForScreen?.(chapter)).catch(() => {});
}

function installNovelChapterFlow(runtime) {
  function cancelPreviousTask(state) {
    if (!state.taskId) return;
    runtime.cancelNovelTranslationStream?.(state.taskId);
    void runtime.sendRuntimeMessage?.({ type: "CANCEL_TRANSLATION_TASK", taskId: state.taskId })?.catch?.(() => {});
  }

  function hasImportedTranslations(state, allItems) {
    return allItems.some(item => state.translations.has(item.id));
  }

  async function translateNovelText(chapter, options = {}) {
    const state = runtime.getNovelState();
    cancelPreviousTask(state);
    // 「开始翻的是哪一屏」要在动手前抓：收尾时再算就已是新屏，比不出差异。
    const startSignature = runtime.novelSurfaceSignature?.(chapter.surface) || "";
    state.taskId = `novel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const allItems = getTranslatableParagraphs(runtime, chapter);
    if (options.force) state.translations.clear();
    else await runtime.applyCachedNovelTranslations?.(chapter, state);
    // 手机版没有本地服务这一层：缓存与网络都直连，界面上不再出现「服务离线」分支。
    state.serviceOnline = true;
    state.progress.textTotal = allItems.length;
    let pending = allItems.filter(item => !state.translations.has(item.id));
    state.progress.textDone = allItems.length - pending.length;
    if (!pending.length) {
      state.textStatus = "complete";
      state.showTranslation = true;
      revealTranslations(runtime, chapter);
      runtime.setNovelTextStatus?.("complete", state.progress);
      return { ok: true, completed: true, translated: allItems.length, showTranslation: true };
    }
    state.textStatus = NOVEL_STATUS_WORKING;
    state.progress.textPhase = "正在准备术语与上下文…";
    runtime.setNovelTextStatus?.(NOVEL_STATUS_WORKING, state.progress);
    const fingerprint = await runtime.getTranslationConfigFingerprint(
      "novel", typeof location !== "undefined" ? location.href : ""
    );
    state.streamState = "progressive-batch";
    const progressive = await runtime.runNovelProgressiveTranslation({
      chapter,
      state,
      allItems,
      pending,
      force: options.force === true,
      fingerprint
    });
    pending = allItems.filter(item => !state.translations.has(item.id));
    const missing = new Set(pending.map(item => item.id));
    // 同一段可能同时留下「块级失败」和「逐段补齐失败」两条记录，按 id 去重后再报，
    // 否则界面上会把 2 段失败显示成 4 段。
    const errorsById = new Map();
    for (const error of progressive && progressive.errors || []) {
      const id = String(error && error.id || "");
      if (id && missing.has(id)) errorsById.set(id, error);
    }
    const errors = [...errorsById.values()];
    const warnings = (progressive && progressive.warnings || []).filter(warning => state.translations.has(String(warning.id)));
    const completed = pending.length === 0;
    state.textStatus = completed ? "complete" : "partial";
    state.streamState = completed ? "completed" : "paragraph-recovery";
    state.progress.textPhase = completed
      ? "正文翻译完成"
      : `仍有 ${pending.length} 段未完成，再点小说球可继续补翻`;
    runtime.publishTextDiagnostics?.(state, errors, warnings);
    state.showTranslation = true;
    const liveSurface = revealTranslations(runtime, chapter);
    runtime.setNovelTextStatus?.(state.textStatus, state.progress);
    // 翻译期间用户翻了屏：新一屏一个字都还没有，而它的段落节点跟这次翻译毫无关系，
    // 直接接着翻新屏（continueNovel 内部有 screenContinueTask 重入保护）。
    const liveSignature = liveSurface ? runtime.novelSurfaceSignature?.(liveSurface) || "" : "";
    if (liveSurface && startSignature && liveSignature && liveSignature !== startSignature) {
      void runtime.continueNovelTranslationForCurrentScreen?.(liveSurface);
    }
    return { ok: completed, completed, translated: state.translations.size, errors, warnings };
  }

  async function translateNovelChapter(options = {}) {
    const surface = runtime.reconcileNovelReader();
    const chapter = runtime.extractNovelChapter(surface);
    if (!chapter) return { ok: false, unavailable: true, error: "当前页面不是可识别的小说章节" };
    const state = runtime.getNovelState();
    runtime.resetNovelForChapter(chapter, state);
    if (state.textStatus === NOVEL_STATUS_WORKING) return { ok: true, reused: true };
    // KakaoPage 是分屏阅读，「整章已完成」只代表此前访问过的屏；这里按当前屏重算待翻译集合。
    const screenMissing = getTranslatableParagraphs(runtime, chapter)
      .filter(item => !state.translations.has(item.id));
    if (!screenMissing.length) {
      if (options.missingOnly) {
        afterScreenTranslated(runtime, chapter);
        return { ok: true, completed: true, reused: true };
      }
      if (state.textStatus === "complete" && !options.force) {
        state.showTranslation = !state.showTranslation;
        runtime.reapplyNovelTranslations?.(surface);
        runtime.setNovelTranslationVisibility(state.showTranslation);
        return { ok: true, toggled: true, showTranslation: state.showTranslation };
      }
    }
    try {
      const result = await translateNovelText(chapter, { force: options.force === true });
      if (result && result.translated > 0) afterScreenTranslated(runtime, chapter);
      return result;
    } catch (error) {
      state.textStatus = "partial";
      runtime.setNovelTextStatus?.("partial", state.progress, runtime.getErrorMessage(error));
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }

  /** 翻屏补翻：原实现同样要过本地服务检查，这里只保留缓存 + 直连翻译两段。 */
  async function continueNovelTranslationForCurrentScreen(surface) {
    const state = runtime.getNovelState();
    if (state.textStatus !== "complete" && state.textStatus !== "partial") return { skipped: true };
    if (state.screenContinueTask) return { skipped: true, inFlight: true };
    const chapter = runtime.extractNovelChapter(surface);
    if (!chapter) return { skipped: true };
    runtime.resetNovelForChapter(chapter, state);
    const items = getTranslatableParagraphs(runtime, chapter);
    if (!items.length) return { skipped: true };
    state.screenContinueTask = true;
    try {
      const cached = await runtime.applyCachedNovelTranslations?.(chapter, state);
      const missing = items.filter(item => !state.translations.has(item.id));
      state.progress.textTotal = items.length;
      state.progress.textDone = items.length - missing.length;
      if (!missing.length) {
        if (cached && cached.hit > 0) runtime.setNovelTextStatus?.("complete", state.progress);
        afterScreenTranslated(runtime, chapter);
        return { ok: true, cachedOnly: true, hit: cached ? cached.hit : 0 };
      }
      return await translateNovelText(chapter, { missingOnly: true }).then(result => {
        afterScreenTranslated(runtime, chapter);
        return result;
      });
    } finally {
      state.screenContinueTask = false;
    }
  }

  return { translateNovelChapter, continueNovelTranslationForCurrentScreen, translateNovelText, hasImportedTranslations };
}

/** 手机版不处理正文插图（需要 OCR 服务）。 */
const noImages = async () => ({ ok: true, total: 0 });

function hideBall(ball) {
  if (ball) ball.hidden = true;
}

/**
 * 隐藏漫画/网页两个球，并从小说菜单里去掉两项手机版做不到的动作。
 *
 * `floatingStates.buildNovelMenuItems` 是模块静态函数（不在 runtime 上），没法覆盖，
 * 所以在 bindBallContextMenu 的包装里过滤它拿到的菜单项。
 */
function installFloatingOverrides(runtime) {
  const MOBILE_HIDDEN_MENU_IDS = new Set(["retranslate-images", "manage-chapter"]);
  const createFloatingBall = runtime.createFloatingBall;
  if (typeof createFloatingBall === "function") {
    runtime.createFloatingBall = (...args) => {
      const result = createFloatingBall(...args);
      hideBall(runtime.state.floatingComicBall);
      hideBall(runtime.state.floatingWebpageBall);
      return result;
    };
  }
  const bindBallContextMenu = runtime.bindBallContextMenu;
  if (typeof bindBallContextMenu !== "function") return;
  runtime.bindBallContextMenu = (ball, getContext) => {
    if (ball && (ball.classList.contains("mt-floating-comic") || ball.classList.contains("mt-floating-webpage"))) return;
    const filterItems = () => {
      const items = getContext();
      return Array.isArray(items) ? items.filter(item => !MOBILE_HIDDEN_MENU_IDS.has(String(item && item.id || ""))) : items;
    };
    const isNovelBall = Boolean(ball && ball.classList.contains("mt-floating-novel"));
    return bindBallContextMenu(ball, isNovelBall ? filterItems : getContext);
  };
}

export function applyContentLocal(runtime) {
  const flow = installNovelChapterFlow(runtime);
  runtime.translateNovelChapter = flow.translateNovelChapter;
  runtime.continueNovelTranslationForCurrentScreen = flow.continueNovelTranslationForCurrentScreen;
  // 章节流程调用的是 runtime.runNovelProgressiveTranslation，这里换成并发小批版。
  installNovelBatch(runtime);
  installMobileProgressLabels(runtime);
  runtime.translateNovelImages = noImages;
  runtime.retryNovelImages = noImages;
  runtime.resumeNovelImagesIfIdle = () => {};
  runtime.ensureTranslationServiceOnline = async () => ({ ok: true, status: "local", records: [], changeSeq: 0 });
  runtime.runNovelTranslationStream = () => Promise.reject(new Error("手机版不支持流式翻译"));
  installFloatingOverrides(runtime);
  // reader-api.js 在 state 阶段就按值把这两个函数拷进了 runtime.api（__MANGA_TRANSLATOR_V3__），
  // 不跟着覆盖的话，从 api 进来的调用仍然是桌面版实现。
  if (runtime.api) {
    runtime.api.translateNovelChapter = runtime.translateNovelChapter;
    runtime.api.retryNovelImages = runtime.retryNovelImages;
  }
}
