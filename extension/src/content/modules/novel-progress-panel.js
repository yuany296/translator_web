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
        : "失败段落会保留韩文，再点小说球只补翻缺失内容。"
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

export function installNovelProgressPanel(runtime) {
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
  runtime.createNovelProgressPanel = createNovelProgressPanel;

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
    if (error) progress.textPhase = error;
    updateNovelProgressPanel();
    runtime.updateFloatingBallState?.();
  };
  runtime.setNovelImageStatus = (status, progress, error = "") => {
    if (error) progress.imagePhase = error;
    updateNovelProgressPanel();
    runtime.updateFloatingBallState?.();
  };
}
