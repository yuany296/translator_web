const DRAG_THRESHOLD_PX = 7;
const EDGE_GAP_PX = 14;
const COMPACT_BALL_SIZE_PX = 40;
const COMPACT_PAIR_HEIGHT_PX = 88;

function toProgressPercent(done, total) {
  const count = Math.max(0, Number(total) || 0);
  if (!count) return 0;
  return Math.min(100, Math.max(0, Math.round((Math.max(0, Number(done) || 0) / count) * 100)));
}

export function buildNovelProgressView(novel = {}, visiblePending = false) {
  const progress = novel.progress || {};
  const working = novel.textStatus === "working" || novel.imageStatus === "working";
  const partial = !working && (novel.textStatus === "partial" || novel.imageStatus === "partial");
  const variant = working ? "working" : partial ? "partial" : "complete";
  const title = working ? "小说精翻进行中" : partial ? "小说翻译部分完成" : "小说翻译完成";
  const phase = novel.textStatus === "working"
    ? progress.textPhase || "正在准备正文精翻…"
    : novel.imageStatus === "working"
      ? progress.imagePhase || "正在处理正文图片…"
      : progress.textPhase || progress.imagePhase || title;
  const note = working
    ? visiblePending
      ? "为保持上下文一致，正文按章节顺序精翻；当前页尚未轮到时会暂时保留韩文。"
      : "译文会按章节顺序逐段显示，图片任务在后台独立处理。"
    : partial
      ? progress.textDiagnostic
        ? `诊断：${progress.textDiagnostic}`
        : "失败段落会保留韩文，再点“文”只补翻缺失内容。"
      : progress.textWarning || "正文与图片任务已经结束。";
  return {
    variant,
    title,
    phase,
    note,
    textLabel: `正文 ${Number(progress.textDone) || 0}/${Number(progress.textTotal) || 0}`,
    imageLabel: `图片 ${Number(progress.imageDone) || 0}/${Number(progress.imageTotal) || 0}`,
    textPercent: toProgressPercent(progress.textDone, progress.textTotal),
    imagePercent: toProgressPercent(progress.imageDone, progress.imageTotal)
  };
}

export function buildFloatingControlView(novelAvailable, autoTranslateEnabled) {
  if (novelAvailable) {
    return {
      imageLabel: "图",
      imageTitle: "翻译漫画或重试小说正文图片"
    };
  }
  return {
    imageLabel: autoTranslateEnabled ? "停" : "译",
    imageTitle: autoTranslateEnabled ? "关闭本页自动翻译" : "翻译当前视口漫画目标"
  };
}

export function installControlsDual(runtime) {
  function isSuppressedClick() {
    return Date.now() < Number(runtime.state.suppressFloatingClickUntil || 0);
  }

  async function onTextClick(event) {
    runtime.stopExtensionUiEvent(event);
    if (isSuppressedClick() || runtime.state.invalidated || !runtime.state.enabled) return;
    if (!runtime.findKakaoNovelSurface()) {
      runtime.showFloatingBallFeedback("当前页面没有检测到 Kakao 小说正文", "info");
      return;
    }
    const state = runtime.getNovelState();
    if (state.textStatus === "working") {
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

  async function onImageClick(event) {
    runtime.stopExtensionUiEvent(event);
    if (isSuppressedClick() || runtime.state.invalidated || !runtime.state.enabled) return;
    if (runtime.findKakaoNovelSurface()) {
      runtime.openNovelImagePanel?.();
      if (runtime.getNovelState().imageStatus === "working") return;
      let result;
      try {
        result = await runtime.retryNovelImages();
      } catch (error) {
        result = { ok: false, error: runtime.getErrorMessage(error), failed: 1 };
      }
      runtime.clearFloatingBallFeedback?.();
      runtime.updateNovelProgressPanel?.();
      return;
    }
    if (runtime.state.autoTranslatePageEnabled) {
      await runtime.togglePageAutoTranslate(false);
      return;
    }
    if (runtime.isAutomaticPretranslateMode(runtime.state.pretranslateMode)) {
      await runtime.togglePageAutoTranslate(true);
      return;
    }
    await runtime.manualTranslateVisible();
  }

  function createBall(label, className, title, onClick) {
    const ball = document.createElement("button");
    ball.type = "button";
    ball.className = `mt-floating-ball ${className}`;
    ball.textContent = label;
    ball.title = title;
    ball.addEventListener("click", event => void onClick(event));
    return ball;
  }

  function createProgressRow(label, kind) {
    const row = document.createElement("div");
    row.className = "mt-novel-progress-row";
    const text = document.createElement("span");
    text.className = "mt-novel-progress-label";
    text.textContent = label;
    const track = document.createElement("span");
    track.className = "mt-novel-progress-track";
    const fill = document.createElement("span");
    fill.className = "mt-novel-progress-fill";
    track.appendChild(fill);
    row.append(text, track);
    return { row, text, fill, kind };
  }

  function createNovelProgressPanel() {
    const panel = document.createElement("section");
    panel.className = "mt-novel-progress-panel";
    panel.dataset.mangaTranslatorOverlay = "true";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    panel.hidden = true;
    const header = document.createElement("div");
    header.className = "mt-novel-progress-header";
    const spinner = document.createElement("span");
    spinner.className = "mt-novel-progress-spinner";
    const title = document.createElement("strong");
    header.append(spinner, title);
    const phase = document.createElement("div");
    phase.className = "mt-novel-progress-phase";
    const textRow = createProgressRow("正文 0/0", "text");
    const imageRow = createProgressRow("图片 0/0", "image");
    const note = document.createElement("div");
    note.className = "mt-novel-progress-note";
    panel.append(header, phase, textRow.row, imageRow.row, note);
    runtime.state.novelProgressPanel = panel;
    runtime.state.novelProgressElements = { title, phase, note, spinner, textRow, imageRow };
    return panel;
  }

  function createFloatingBall() {
    if (runtime.state.floatingBallWrap?.isConnected) return;
    const wrap = document.createElement("div");
    wrap.className = "mt-floating-ball-wrap mt-floating-ball-pair";
    wrap.dataset.mangaTranslatorOverlay = "true";
    const feedback = document.createElement("div");
    feedback.className = "mt-floating-feedback";
    feedback.dataset.mangaTranslatorOverlay = "true";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    feedback.hidden = true;
    const textBall = createBall("文", "mt-floating-text", "翻译或切换 Kakao 小说正文", onTextClick);
    const imageBall = createBall("图", "mt-floating-image", "翻译漫画或重试小说正文图片", onImageClick);
    wrap.append(feedback, textBall, imageBall);
    wrap.append(createNovelProgressPanel());
    bindPairDrag(wrap);
    document.documentElement.appendChild(wrap);
    Object.assign(runtime.state, {
      floatingBallWrap: wrap,
      floatingBall: imageBall,
      floatingTextBall: textBall,
      floatingImageBall: imageBall,
      floatingBallClose: null,
      floatingBallFeedback: feedback
    });
    applyFloatingPosition();
    runtime.updateFloatingBallState();
    if (!runtime.state.floatingResizeBound) {
      runtime.state.floatingResizeBound = true;
      window.addEventListener("resize", applyFloatingPosition, { passive: true });
    }
  }
  runtime.createFloatingBall = createFloatingBall;

  function bindPairDrag(wrap) {
    let drag = null;
    const move = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      // 只有确认是拖动后才捕获指针；按下时捕获会把按钮 click 重定向到父容器。
      wrap.setPointerCapture?.(event.pointerId);
      wrap.classList.add("mt-dragging");
      const maxLeft = Math.max(0, window.innerWidth - wrap.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - wrap.offsetHeight);
      wrap.style.left = `${Math.min(maxLeft, Math.max(0, drag.left + dx))}px`;
      wrap.style.right = "auto";
      wrap.style.top = `${Math.min(maxTop, Math.max(0, drag.top + dy))}px`;
      event.preventDefault();
    };
    const end = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      wrap.classList.remove("mt-dragging");
      if (drag.moved) {
        runtime.state.suppressFloatingClickUntil = Date.now() + 450;
        persistSnappedPosition(wrap);
        event.preventDefault();
        event.stopPropagation();
      }
      drag = null;
    };
    wrap.addEventListener("pointerdown", event => {
      if (event.button !== undefined && event.button !== 0) return;
      const rect = wrap.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
      event.stopPropagation();
    });
  }

  function persistSnappedPosition(wrap) {
    const rect = wrap.getBoundingClientRect();
    const side = rect.left + rect.width / 2 < window.innerWidth / 2 ? "left" : "right";
    const available = Math.max(1, window.innerHeight - rect.height);
    const yRatio = Math.min(1, Math.max(0, rect.top / available));
    runtime.state.floatingSide = side;
    runtime.state.floatingYRatio = yRatio;
    applyFloatingPosition();
    void runtime.updateRuntimeConfiguration({ floatingSide: side, floatingYRatio: yRatio });
  }

  function applyFloatingPosition() {
    const wrap = runtime.state.floatingBallWrap;
    if (!wrap) return;
    const side = runtime.state.floatingSide === "left" ? "left" : "right";
    const fallbackHeight = wrap.classList.contains("mt-floating-ball-pair")
      ? COMPACT_PAIR_HEIGHT_PX
      : COMPACT_BALL_SIZE_PX;
    const available = Math.max(0, window.innerHeight - (wrap.offsetHeight || fallbackHeight));
    const top = Math.round(Math.min(1, Math.max(0, Number(runtime.state.floatingYRatio) || 0)) * available);
    wrap.style.top = `${top}px`;
    wrap.style.bottom = "auto";
    wrap.style.left = side === "left" ? `${EDGE_GAP_PX}px` : "auto";
    wrap.style.right = side === "right" ? `${EDGE_GAP_PX}px` : "auto";
    wrap.dataset.side = side;
    wrap.dataset.progressPlacement = Number.parseFloat(wrap.style.top || "0") < 190 ? "below" : "above";
    runtime.syncNovelImagePanelSide?.();
  }
  runtime.applyFloatingPosition = applyFloatingPosition;

  function setButtonStatus(button, status) {
    if (!button) return;
    for (const name of ["working", "complete", "partial", "unavailable"]) {
      button.classList.toggle(`mt-${name}`, status === name);
    }
  }

  function updateFloatingBallState() {
    const state = runtime.state;
    if (!state.floatingBallWrap) return;
    state.floatingBallWrap.classList.toggle("mt-hidden", !state.showFloatingBall);
    const unavailable = !state.enabled || state.invalidated;
    const novelAvailable = !!runtime.findKakaoNovelSurface();
    const autoTranslateEnabled = state.autoTranslatePageEnabled && state.enabled;
    const view = buildFloatingControlView(novelAvailable, autoTranslateEnabled);
    if (state.floatingImageBall) {
      state.floatingImageBall.textContent = view.imageLabel;
      state.floatingImageBall.title = view.imageTitle;
    }
    state.floatingTextBall?.classList.toggle("mt-disabled", unavailable || !novelAvailable);
    state.floatingImageBall?.classList.toggle("mt-disabled", unavailable);
    state.floatingImageBall?.classList.toggle("mt-auto-enabled", autoTranslateEnabled);
    if (novelAvailable) {
      const novel = runtime.getNovelState();
      setButtonStatus(state.floatingTextBall, novel.textStatus);
      setButtonStatus(state.floatingImageBall, novel.imageStatus);
    } else {
      setButtonStatus(state.floatingTextBall, "unavailable");
      setButtonStatus(state.floatingImageBall, state.autoTranslatePageEnabled ? "complete" : "idle");
    }
    applyFloatingPosition();
  }
  runtime.updateFloatingBallState = updateFloatingBallState;

  function hasVisiblePendingParagraph() {
    const surface = runtime.getNovelState().surface || runtime.findKakaoNovelSurface();
    return !!surface?.paragraphs?.some(node => {
      if (node.querySelector?.(":scope > .mt-novel-translation")) return false;
      const rect = node.getBoundingClientRect?.();
      return rect && rect.width > 0 && rect.height > 0 &&
        rect.left < window.innerWidth && rect.right > 0 &&
        rect.top < window.innerHeight && rect.bottom > 0;
    });
  }

  function updateNovelProgressPanel() {
    const panel = runtime.state.novelProgressPanel;
    const elements = runtime.state.novelProgressElements;
    if (!panel || !elements) return;
    const novel = runtime.getNovelState();
    const active = ["working", "partial", "complete"].includes(novel.textStatus) ||
      ["working", "partial", "complete"].includes(novel.imageStatus);
    if (!active) {
      panel.hidden = true;
      return;
    }
    const view = buildNovelProgressView(novel, hasVisiblePendingParagraph());
    panel.hidden = false;
    panel.className = `mt-novel-progress-panel mt-${view.variant}`;
    if (novel.progress?.textDiagnosticDetails) {
      panel.dataset.novelDiagnostics = JSON.stringify(novel.progress.textDiagnosticDetails);
    } else {
      delete panel.dataset.novelDiagnostics;
    }
    elements.title.textContent = view.title;
    elements.phase.textContent = view.phase;
    elements.note.textContent = view.note;
    elements.textRow.text.textContent = view.textLabel;
    elements.imageRow.text.textContent = view.imageLabel;
    elements.textRow.fill.style.width = `${view.textPercent}%`;
    elements.imageRow.fill.style.width = `${view.imagePercent}%`;
    if (runtime.state.novelProgressHideTimer) {
      window.clearTimeout(runtime.state.novelProgressHideTimer);
      runtime.state.novelProgressHideTimer = 0;
    }
    if (view.variant === "complete") {
      runtime.state.novelProgressHideTimer = window.setTimeout(() => {
        panel.hidden = true;
        runtime.state.novelProgressHideTimer = 0;
      }, 4500);
    }
  }
  runtime.updateNovelProgressPanel = updateNovelProgressPanel;
  runtime.buildNovelProgressView = buildNovelProgressView;

  runtime.setNovelTextStatus = (status, progress, error = "") => {
    setButtonStatus(runtime.state.floatingTextBall, status);
    if (error) progress.textPhase = error;
    updateNovelProgressPanel();
  };
  runtime.setNovelImageStatus = (status, progress, error = "") => {
    setButtonStatus(runtime.state.floatingImageBall, status);
    if (error) progress.imagePhase = error;
    updateNovelProgressPanel();
  };
  runtime.setFloatingBallWorking = working => setButtonStatus(runtime.state.floatingImageBall, working ? "working" : "idle");
}
