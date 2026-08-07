import floatingActions from "../../shared/floating-actions.js";
import floatingStates from "./floating-states.js";

const SURFACE_SETTLE_MS = 1200;

/**
 * The unified floating action group: three icon balls (novel / comic /
 * webpage) dragged as one group. Subject icons never change with state;
 * status is expressed through ring, badge, opacity, tooltip and aria-label.
 * Drag/snap/persistence live in floating-position.js; menus in
 * floating-menu.js; pure state derivation in floating-states.js.
 */
export function installControlsTriple(runtime) {
  function isSuppressedClick() {
    return Date.now() < Number(runtime.state.suppressFloatingClickUntil || 0);
  }

  function buildNovelContext() {
    const novel = runtime.getNovelState();
    const surface = novel.surface || runtime.findKakaoNovelSurface();
    return {
      enabled: runtime.state.enabled,
      invalidated: runtime.state.invalidated,
      kakaoReader: !!runtime.IS_KAKAOPAGE_READER,
      surfaceFound: !!surface,
      surfaceSettled: runtime.state.novelSurfaceSettled !== false,
      textStatus: novel.textStatus,
      imageStatus: novel.imageStatus,
      showTranslation: novel.showTranslation,
      cacheStatus: Date.now() < Number(novel.cacheBadgeUntil || 0) ? "none" : (novel.cacheStatus || "none"),
      translatedCount: novel.translations.size,
      errorMessage: novel.progress?.textDiagnostic || ""
    };
  }

  function buildComicContext() {
    return {
      enabled: runtime.state.enabled,
      invalidated: runtime.state.invalidated,
      running: runtime.state.autoTranslatePageEnabled && runtime.state.enabled,
      working: runtime.state.comicWorking === true,
      overlayVisible: runtime.getOverlayLayerVisibility?.() !== false
    };
  }

  function buildWebpageContext() {
    const state = runtime.getWebpageState?.() || {};
    const controller = state.controller || {};
    const session = state.session;
    const progress = session ? runtime.getVisibleWebpageProgress?.(session) : null;
    return {
      enabled: runtime.state.enabled,
      invalidated: runtime.state.invalidated,
      mode: controller.mode || "off",
      visibility: controller.visibility || "source",
      working: state.working === true,
      queueBusy: runtime.isWebpageQueueBusy?.() === true,
      pageFault: state.pageFault || null,
      pendingSave: progress?.pendingSave || 0,
      realFailed: progress?.realFailed || 0,
      viewportTotal: progress?.viewportTotal || 0,
      viewportDone: progress?.viewportDone || 0,
      backgroundTotal: progress?.backgroundTotal || 0,
      backgroundDone: progress?.backgroundDone || 0,
      errorMessage: state.pageFault?.error || state.errorMessage || "",
      cacheStatus: Date.now() < Number(state.cacheBadgeUntil || 0) ? "none" : (state.cacheStatus || "none")
    };
  }

  async function onNovelClick(event) {
    runtime.stopExtensionUiEvent(event);
    if (isSuppressedClick() || runtime.state.invalidated || !runtime.state.enabled) return;
    const state = floatingStates.buildNovelState(buildNovelContext());
    if (state.availability === "disabled") {
      runtime.showFloatingBallFeedback(state.availabilityReason, "info");
      return;
    }
    if (state.availability === "detecting") {
      runtime.showFloatingBallFeedback("正在检测 Kakao 小说页面…", "info");
      return;
    }
    if (state.phase === "loading") {
      runtime.updateNovelProgressPanel?.();
      return;
    }
    let result;
    try {
      result = await runtime.translateNovelChapter();
    } catch (error) {
      result = { ok: false, error: runtime.getErrorMessage(error) };
    }
    if (result?.toggled) {
      runtime.showFloatingBallFeedback(result.showTranslation ? "已显示中文译文" : "已显示韩文原文", "info");
    } else {
      runtime.clearFloatingBallFeedback?.();
      runtime.updateNovelProgressPanel?.();
    }
  }

  async function onComicClick(event) {
    runtime.stopExtensionUiEvent(event);
    if (isSuppressedClick() || runtime.state.invalidated || !runtime.state.enabled) return;
    if (runtime.state.autoTranslatePageEnabled) {
      await runtime.togglePageAutoTranslate(false);
      runtime.showFloatingBallFeedback("已停止漫画连续翻译，已显示的译文保留", "info");
      return;
    }
    await runtime.togglePageAutoTranslate(true);
    runtime.showFloatingBallFeedback("开始漫画连续翻译", "info");
  }

  async function onWebpageClick(event) {
    runtime.stopExtensionUiEvent(event);
    if (isSuppressedClick() || runtime.state.invalidated || !runtime.state.enabled) return;
    const state = runtime.getWebpageState();
    const controller = state.controller || {};
    if (controller.mode === "continuous") {
      if (controller.visibility === "translated") {
        // 持续模式且显示译文 → 显示原文（后台继续翻译）
        const result = runtime.restoreWebpageTranslation();
        runtime.showFloatingBallFeedback(result.ok ? "已显示网页原文，后台继续翻译" : "恢复网页原文失败", result.ok ? "info" : "error");
        return;
      }
      // 持续模式且显示原文 → 重新显示译文
      const result = runtime.showWebpageTranslations();
      if (result.shown > 0) {
        runtime.showFloatingBallFeedback("已重新显示中文译文", "info");
      } else {
        runtime.clearFloatingBallFeedback();
        const rerun = await runtime.translateWebpage();
        if (!rerun?.ok && !rerun?.reused) {
          runtime.showFloatingBallFeedback(rerun?.offline ? "本地服务未启动，已缓存内容仍显示" : (rerun?.error || "网页翻译失败"), "error");
        }
      }
      return;
    }
    // 模式关闭 → 开启持续翻译并显示译文
    runtime.clearFloatingBallFeedback();
    const result = await runtime.translateWebpage();
    if (!(result?.ok || result?.reused)) {
      runtime.showFloatingBallFeedback(result?.cancelled ? "" : (result?.offline ? "本地服务未启动，已缓存内容仍显示" : (result?.error || "网页翻译失败")), "error");
    }
  }

  function createBall(actionId, onClick) {
    const ball = document.createElement("button");
    ball.type = "button";
    ball.className = `mt-floating-ball mt-floating-${actionId}`;
    const icon = document.createElement("img");
    icon.className = "mt-floating-icon";
    icon.src = floatingActions.resolveFloatingActionIcon(actionId);
    icon.alt = "";
    icon.draggable = false;
    // 图标加载失败时的中性占位（圆+问号），明确不是正式图标
    icon.addEventListener("error", () => {
      if (icon.dataset.mtPlaceholder === "true") return;
      icon.dataset.mtPlaceholder = "true";
      icon.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="rgba(255,255,255,0.92)"/><text x="16" y="22" text-anchor="middle" font-size="16" fill="#64748b">?</text></svg>')}`;
    });
    const ring = document.createElement("span");
    ring.className = "mt-floating-ring";
    ring.hidden = true;
    const badge = document.createElement("span");
    badge.className = "mt-floating-badge";
    badge.hidden = true;
    ball.append(icon, ring, badge);
    ball.addEventListener("click", event => void onClick(event));
    return ball;
  }

  function createFloatingBall() {
    if (runtime.state.floatingBallWrap?.isConnected) return;
    const wrap = document.createElement("div");
    wrap.className = "mt-floating-ball-wrap mt-floating-ball-group";
    wrap.dataset.mangaTranslatorOverlay = "true";
    const feedback = document.createElement("div");
    feedback.className = "mt-floating-feedback";
    feedback.dataset.mangaTranslatorOverlay = "true";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    feedback.hidden = true;
    const novelBall = createBall("novel", onNovelClick);
    const comicBall = createBall("comic", onComicClick);
    const webpageBall = createBall("webpage", onWebpageClick);
    wrap.append(feedback, novelBall, comicBall, webpageBall);
    wrap.append(runtime.createNovelProgressPanel());
    runtime.bindFloatingGroupDrag(wrap);
    document.documentElement.appendChild(wrap);
    Object.assign(runtime.state, {
      floatingBallWrap: wrap,
      floatingBall: comicBall,
      floatingNovelBall: novelBall,
      floatingComicBall: comicBall,
      floatingWebpageBall: webpageBall,
      floatingBallClose: null,
      floatingBallFeedback: feedback
    });
    runtime.bindBallContextMenu?.(novelBall, buildNovelMenu);
    runtime.bindBallContextMenu?.(comicBall, buildComicMenu);
    runtime.bindBallContextMenu?.(webpageBall, buildWebpageMenu);
    runtime.applyFloatingPosition();
    runtime.updateFloatingBallState();
    if (!runtime.state.novelSurfaceSettled) {
      runtime.state.novelSurfaceSettled = false;
      window.setTimeout(() => {
        runtime.state.novelSurfaceSettled = true;
        runtime.updateFloatingBallState();
      }, SURFACE_SETTLE_MS);
    }
    if (!runtime.state.floatingResizeBound) {
      runtime.state.floatingResizeBound = true;
      window.addEventListener("resize", runtime.applyFloatingPosition, { passive: true });
    }
    void runtime.analyzeWebpageCacheStatus?.();
    void runtime.analyzeNovelCacheStatus?.();
  }
  runtime.createFloatingBall = createFloatingBall;

  function applyBallState(ball, presentation) {
    if (!ball) return;
    ball.classList.toggle("mt-disabled", presentation.disabled === true);
    ball.classList.toggle("mt-status-working", presentation.spinner === true);
    ball.classList.toggle("mt-status-running", presentation.runningRing === true);
    ball.title = presentation.tooltip;
    ball.setAttribute("aria-label", presentation.ariaLabel);
    const ring = ball.querySelector(".mt-floating-ring");
    if (ring) ring.hidden = !(presentation.spinner === true || presentation.runningRing === true);
    const badge = ball.querySelector(".mt-floating-badge");
    if (badge) {
      badge.hidden = !presentation.badge;
      badge.dataset.badge = presentation.badge || "";
      badge.innerHTML = presentation.badge ? (floatingStates.BADGE_SVG[presentation.badge] || "") : "";
    }
  }

  function maybeAnalyzeNovelCache() {
    const novel = runtime.getNovelState();
    if (runtime.analyzeNovelCacheStatus && runtime.IS_KAKAOPAGE_READER &&
      novel.textStatus === "idle" && !novel.cacheAnalysisPending && runtime.findKakaoNovelSurface()) {
      novel.cacheAnalysisPending = true;
      void runtime.analyzeNovelCacheStatus().finally(() => {
        novel.cacheAnalysisPending = false;
      });
    }
  }

  function maybeAnalyzeWebpageCache() {
    const state = runtime.getWebpageState();
    if (runtime.analyzeWebpageCacheStatus && !state.working && !state.cacheAnalysisPending &&
      state.cacheCheckedKey !== runtime.normalizeTranslationCacheUrl()) {
      state.cacheAnalysisPending = true;
      void runtime.analyzeWebpageCacheStatus().finally(() => {
        state.cacheAnalysisPending = false;
      });
    }
  }

  function updateFloatingBallState() {
    const state = runtime.state;
    if (!state.floatingBallWrap) return;
    state.floatingBallWrap.classList.toggle("mt-hidden", !state.showFloatingBall);
    applyBallState(state.floatingNovelBall, floatingStates.deriveFloatingActionPresentation("novel", floatingStates.buildNovelState(buildNovelContext())));
    applyBallState(state.floatingComicBall, floatingStates.deriveFloatingActionPresentation("comic", floatingStates.buildComicState(buildComicContext())));
    applyBallState(state.floatingWebpageBall, floatingStates.deriveFloatingActionPresentation("webpage", floatingStates.buildWebpageState(buildWebpageContext())));
    maybeAnalyzeNovelCache();
    maybeAnalyzeWebpageCache();
    runtime.applyFloatingPosition();
  }
  runtime.updateFloatingBallState = updateFloatingBallState;

  runtime.setFloatingBallWorking = working => {
    runtime.state.comicWorking = !!working;
    runtime.updateFloatingBallState();
  };

  function handleNovelMenuAction(id) {
    const novel = runtime.getNovelState();
    switch (id) {
      case "translate-chapter":
        return void runtime.translateNovelChapter().then(result => {
          runtime.updateNovelProgressPanel?.();
          if (result?.ok === false && result.error) runtime.showFloatingBallFeedback(result.error, "error");
        });
      case "translate-missing":
        return void runtime.translateNovelChapter({ missingOnly: true }).then(() => runtime.updateNovelProgressPanel?.());
      case "show-translation":
        novel.showTranslation = true;
        runtime.setNovelTranslationVisibility(true);
        runtime.updateFloatingBallState();
        return;
      case "restore-original":
        novel.showTranslation = false;
        runtime.setNovelTranslationVisibility(false);
        runtime.updateFloatingBallState();
        return;
      case "force-retranslate":
        return void runtime.translateNovelChapter({ force: true }).then(result => {
          runtime.updateNovelProgressPanel?.();
          if (result?.ok === false && result.error) runtime.showFloatingBallFeedback(result.error, "error");
        });
      case "retranslate-text":
        // 只强制重译正文,不动已处理的图片。
        return void runtime.translateNovelChapter({ force: true, textOnly: true }).then(result => {
          runtime.updateNovelProgressPanel?.();
          if (result?.ok === false && result.error) runtime.showFloatingBallFeedback(result.error, "error");
          else runtime.showFloatingBallFeedback("正在强制重新翻译正文", "info");
        });
      case "retranslate-images":
        // 只强制重新处理全部图片,不动正文译文。
        return void runtime.retryNovelImages(true).then(result => {
          runtime.renderNovelImagePanel?.();
          if (result?.ok === false && result.error) runtime.showFloatingBallFeedback(result.error, "error");
          else if (result?.ok !== false) runtime.showFloatingBallFeedback("正在强制重新处理图片", "info");
        });
      case "manage-chapter":
        return void runtime.openNovelRevisionPanel().catch(error =>
          runtime.showFloatingBallFeedback(runtime.getErrorMessage(error), "error"));
      default:
        return;
    }
  }

  function buildNovelMenu() {
    const items = floatingStates.buildNovelMenuItems(floatingStates.buildNovelState(buildNovelContext()));
    return items.map(item => ({ ...item, onSelect: () => handleNovelMenuAction(item.id) }));
  }

  function handleComicMenuAction(id) {
    switch (id) {
      case "translate-viewport":
        return void runtime.manualTranslateVisible();
      case "start-continuous":
        return void runtime.togglePageAutoTranslate(true);
      case "stop-continuous":
        return void runtime.togglePageAutoTranslate(false);
      case "show-overlay":
        runtime.setOverlayLayerVisibility?.(true);
        runtime.updateFloatingBallState();
        return;
      case "hide-overlay":
        runtime.setOverlayLayerVisibility?.(false);
        runtime.updateFloatingBallState();
        return;
      case "clear-overlay":
        runtime.clearAllRenderedTargets();
        runtime.showFloatingBallFeedback("已清除当前页面译文覆盖层", "info");
        return;
      default:
        return;
    }
  }

  function buildComicMenu() {
    const items = floatingStates.buildComicMenuItems(floatingStates.buildComicState(buildComicContext()));
    return items.map(item => ({ ...item, onSelect: () => handleComicMenuAction(item.id) }));
  }

  function handleWebpageMenuAction(id) {
    switch (id) {
      case "translate-page":
        return void runtime.translateWebpage().then(result => {
          if (result?.ok === false && !result?.reused && result.error) {
            runtime.showFloatingBallFeedback(result.error, "error");
          }
        });
      case "restore-page":
        runtime.restoreWebpageTranslation();
        runtime.showFloatingBallFeedback("已显示网页原文，后台继续翻译", "info");
        return;
      case "stop-continuous":
        return void runtime.stopWebpageContinuousTranslation().then(() => {
          runtime.showFloatingBallFeedback("已停止网页持续翻译，已显示译文保留", "info");
        });
      case "retry-failed":
        return void runtime.requeueWebpageSegments?.(["failed"]).then(requeued => {
          runtime.showFloatingBallFeedback(`已重新翻译 ${requeued || 0} 个失败段落`, "info");
        });
      case "retranslate-all":
        return void runtime.requeueWebpageSegments?.(["done", "failed"]).then(requeued => {
          runtime.showFloatingBallFeedback(`已重新翻译 ${requeued || 0} 个段落（绕过缓存）`, "info");
        });
      default:
        return;
    }
  }

  function buildWebpageMenu() {
    const items = floatingStates.buildWebpageMenuItems(floatingStates.buildWebpageState(buildWebpageContext()));
    return items.map(item => ({ ...item, onSelect: () => handleWebpageMenuAction(item.id) }));
  }
}
