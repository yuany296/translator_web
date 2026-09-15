/**
 * Floating-ball feedback overlay timing controller.
 *
 * The overlay (div.mt-floating-feedback) only carries *terminal* messages
 * (done / failed / cancelled / rejected). This module owns the whole
 * lifecycle of a message: write -> countdown -> fade-out -> hidden, plus
 * hover pause / resume (with a minimum resume window), immediate close on
 * click, and timer cleanup on container teardown / page unload.
 *
 * It is a standalone module (not part of controls-ui) so controls-ui stays
 * under the 400-line production gate. All new state lives on runtime.state so
 * it resets together with the container.
 */
export function installFloatingFeedback(runtime) {
  // Single source of truth for the overlay timings (see design §7.1).
  const DURATION_MS = Object.freeze({ info: 2500, success: 2500, error: 6000 });
  runtime.MT_FEEDBACK_DURATION_MS = DURATION_MS;
  runtime.MT_FEEDBACK_FADE_MS = 180;
  runtime.MT_FEEDBACK_MIN_RESUME_MS = 800;
  // Guard band added to the fallback hide timer so the CSS transition is
  // observably complete before we set `hidden`.
  const FADE_FALLBACK_MS = runtime.MT_FEEDBACK_FADE_MS + 120;

  function normalizeLevel(level) {
    return level === "error" ? "error" : level === "success" ? "success" : "info";
  }

  function durationFor(level) {
    return DURATION_MS[normalizeLevel(level)];
  }

  function currentFeedback() {
    const feedback = runtime.state.floatingBallFeedback;
    return feedback && feedback.isConnected !== false ? feedback : null;
  }

  function cancelTimers() {
    if (runtime.state.feedbackTimer) {
      window.clearTimeout(runtime.state.feedbackTimer);
      runtime.state.feedbackTimer = 0;
    }
    if (runtime.state.feedbackFadeTimer) {
      window.clearTimeout(runtime.state.feedbackFadeTimer);
      runtime.state.feedbackFadeTimer = 0;
    }
  }

  function resetFeedbackState() {
    runtime.state.feedbackHovered = false;
    runtime.state.feedbackRemainingMs = 0;
    runtime.state.feedbackDeadline = 0;
  }

  /** Cancel every timer and hide the overlay immediately (no dangling task). */
  function finalizeHide() {
    cancelTimers();
    const feedback = currentFeedback();
    if (feedback) {
      feedback.classList.remove("mt-fading");
      feedback.hidden = true;
    }
    resetFeedbackState();
  }

  /** Start the fade-out transition; `hidden` is only set once it completes. */
  function beginFade() {
    const feedback = currentFeedback();
    // Hovering must never allow a fade (the user is reading the message).
    if (!feedback || feedback.hidden || runtime.state.feedbackHovered === true) {
      if (feedback && !feedback.hidden) return;
      finalizeHide();
      return;
    }
    cancelTimers();
    feedback.classList.add("mt-fading");
    runtime.state.feedbackFadeTimer = window.setTimeout(() => {
      runtime.state.feedbackFadeTimer = 0;
      finalizeHide();
    }, FADE_FALLBACK_MS);
  }

  /** Arm the main countdown, replacing any in-flight timer (at most one). */
  function armTimer(ms) {
    cancelTimers();
    runtime.state.feedbackTimer = window.setTimeout(() => {
      runtime.state.feedbackTimer = 0;
      beginFade();
    }, Math.max(0, Number(ms) || 0));
  }

  /** Pause on hover: cancel the countdown (and any fade) and keep it opaque. */
  function pauseCountdown() {
    const feedback = currentFeedback();
    if (!feedback || feedback.hidden || runtime.state.feedbackHovered === true) return;
    runtime.state.feedbackHovered = true;
    cancelTimers();
    feedback.classList.remove("mt-fading");
    const deadline = Number(runtime.state.feedbackDeadline || 0);
    runtime.state.feedbackRemainingMs = deadline > 0 ? Math.max(0, deadline - Date.now()) : 0;
  }

  /** Resume on mouse-leave, topping the remaining time up to the minimum. */
  function resumeCountdown() {
    const feedback = currentFeedback();
    if (!feedback || feedback.hidden) return;
    runtime.state.feedbackHovered = false;
    const weight = Math.max(Number(runtime.state.feedbackRemainingMs || 0), runtime.MT_FEEDBACK_MIN_RESUME_MS);
    runtime.state.feedbackDeadline = Date.now() + weight;
    runtime.state.feedbackRemainingMs = 0;
    armTimer(weight);
  }

  /**
   * Write a terminal message and (re)start the countdown. Writing the same
   * message again restarts the timer so a repeated click is still visible.
   */
  function showFloatingBallFeedback(message, level = "info") {
    const feedback = currentFeedback();
    if (!feedback) return;
    const text = String(message || "");
    const safeLevel = normalizeLevel(level);
    cancelTimers();
    feedback.classList.remove("mt-fading");
    runtime.state.feedbackHovered = false;
    runtime.state.feedbackRemainingMs = 0;
    runtime.state.feedbackLevel = safeLevel;
    runtime.state.feedbackMessage = text;
    if (!text) {
      // 空文案 = 清除提示:错误弹窗与淡出浮层一并收起。
      hideErrorDialog();
      feedback.hidden = true;
      feedback.classList.remove("mt-info", "mt-success", "mt-error");
      runtime.state.feedbackDeadline = 0;
      return;
    }
    if (safeLevel === "error") {
      // 错误提示改走弹窗:可完整阅读、不会被计时器收走(关闭按钮 / Esc / 点遮罩均可关)。
      // 常规提示(info/success)仍走下方 2.5s 自动淡出浮层。
      finalizeHide();
      showErrorDialog(text);
      return;
    }
    feedback.textContent = text;
    feedback.className = `mt-floating-feedback mt-${safeLevel}`;
    feedback.hidden = false;
    const deadline = Date.now() + durationFor(safeLevel);
    runtime.state.feedbackDeadline = deadline;
    feedback.dataset.mtFeedbackUntil = String(deadline);
    armTimer(durationFor(safeLevel));
  }
  runtime.showFloatingBallFeedback = showFloatingBallFeedback;

  function clearFloatingBallFeedback() {
    runtime.hideFloatingBallFeedback();
  }
  runtime.clearFloatingBallFeedback = clearFloatingBallFeedback;

  /** Immediate hide used by lifecycle hooks: clears both the toast and the error dialog. */
  function hideFloatingBallFeedback() {
    finalizeHide();
    hideErrorDialog();
    runtime.state.feedbackMessage = "";
  }
  runtime.hideFloatingBallFeedback = hideFloatingBallFeedback;

  function hideErrorDialog() {
    const root = runtime.state.errorDialogRoot;
    if (!root || root.hidden) return;
    root.hidden = true;
    const previous = runtime.state.errorDialogPreviousFocus;
    runtime.state.errorDialogPreviousFocus = null;
    if (previous && typeof previous.focus === "function") {
      try { previous.focus(); } catch { /* 焦点恢复失败不影响关闭 */ }
    }
  }

  function ensureErrorDialog() {
    let root = runtime.state.errorDialogRoot;
    if (root && root.isConnected) return root;
    root = document.createElement("div");
    root.className = "mt-error-dialog-root";
    root.dataset.mangaTranslatorOverlay = "true";
    root.setAttribute("role", "alertdialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "翻译出错了");
    root.hidden = true;
    const card = document.createElement("div");
    card.className = "mt-error-dialog-card";
    const head = document.createElement("div");
    head.className = "mt-error-dialog-head";
    const title = document.createElement("span");
    title.className = "mt-error-dialog-title";
    title.textContent = "翻译出错了";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mt-error-dialog-close";
    close.textContent = "×";
    close.title = "关闭";
    head.append(title, close);
    const body = document.createElement("div");
    body.className = "mt-error-dialog-body";
    const foot = document.createElement("div");
    foot.className = "mt-error-dialog-foot";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "mt-error-dialog-dismiss";
    dismiss.textContent = "关闭";
    foot.append(dismiss);
    card.append(head, body, foot);
    root.append(card);
    close.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); hideErrorDialog(); });
    dismiss.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); hideErrorDialog(); });
    card.addEventListener("click", event => event.stopPropagation());
    root.addEventListener("click", () => hideErrorDialog());
    root.addEventListener("keydown", event => {
      if (event && event.key === "Escape") { event.stopPropagation(); hideErrorDialog(); }
    });
    document.documentElement.appendChild(root);
    runtime.state.errorDialogRoot = root;
    runtime.state.errorDialogBody = body;
    return root;
  }

  function showErrorDialog(message) {
    const root = ensureErrorDialog();
    runtime.state.errorDialogBody.textContent = String(message || "");
    const wasHidden = root.hidden;
    root.hidden = false;
    if (wasHidden) {
      runtime.state.errorDialogPreviousFocus = typeof HTMLElement === "function"
        && document.activeElement instanceof HTMLElement ? document.activeElement : null;
      try { root.querySelector(".mt-error-dialog-close")?.focus?.(); } catch { /* 聚焦失败不影响展示 */ }
    }
  }

  /**
   * Idempotently bind hover / click / transition listeners to the overlay
   * element. Read-only w.r.t. the wrap-level interception in controls-ui.
   */
  function bindFloatingFeedbackBehavior(feedbackEl) {
    const feedback = feedbackEl || currentFeedback();
    if (!feedback || feedback.dataset.mtFeedbackBound === "true") return;
    feedback.dataset.mtFeedbackBound = "true";
    feedback.addEventListener("mouseenter", () => pauseCountdown());
    feedback.addEventListener("mouseleave", () => resumeCountdown());
    feedback.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (feedback.hidden) return;
      runtime.state.feedbackHovered = false;
      beginFade();
    });
    feedback.addEventListener("transitionend", event => {
      if (event && event.target !== feedback) return;
      if (feedback.classList.contains("mt-fading")) finalizeHide();
    });
  }
  runtime.bindFloatingFeedbackBehavior = bindFloatingFeedbackBehavior;

  // Page unload must never leave a timer pointing at a dead container.
  window.addEventListener?.("pagehide", () => { finalizeHide(); hideErrorDialog(); }, { once: true });
}
