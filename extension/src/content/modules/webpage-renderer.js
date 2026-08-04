const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "LI", "TD", "TH"]);
const INTERACTIVE_SELECTOR = "a,button,label,input,select,textarea,[role='button'],[role='link'],[role='menuitem'],[role='tab'],nav,menu";

function safeBilingualContainer(entry) {
  const parent = entry?.node?.parentElement;
  if (!parent || !BLOCK_TAGS.has(String(parent.tagName || ""))) return null;
  if (parent.matches(INTERACTIVE_SELECTOR) || parent.querySelector(INTERACTIVE_SELECTOR)) return null;
  const childText = [...parent.childNodes].filter(node => node.nodeType === Node.TEXT_NODE
    && String(node.nodeValue || "").trim());
  return childText.length === 1 && childText[0] === entry.node ? parent : null;
}

function ensureTooltip(state) {
  if (state.tooltip?.isConnected) return state.tooltip;
  const tooltip = document.createElement("div");
  tooltip.className = "mt-webpage-translation-tooltip";
  tooltip.dataset.mangaTranslatorOverlay = "true";
  tooltip.hidden = true;
  document.documentElement.appendChild(tooltip);
  state.tooltip = tooltip;
  return tooltip;
}

function attachTooltip(state, target, translatedText) {
  const tooltip = ensureTooltip(state);
  const show = () => {
    if (!target.isConnected) return;
    const rect = target.getBoundingClientRect();
    tooltip.textContent = translatedText;
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - 328, rect.left))}px`;
    tooltip.style.top = `${Math.min(window.innerHeight - 60, rect.bottom + 8)}px`;
    tooltip.hidden = false;
  };
  const hide = () => { tooltip.hidden = true; };
  target.addEventListener("mouseenter", show);
  target.addEventListener("mouseleave", hide);
  target.addEventListener("focusin", show);
  target.addEventListener("focusout", hide);
  return () => {
    target.removeEventListener("mouseenter", show);
    target.removeEventListener("mouseleave", hide);
    target.removeEventListener("focusin", show);
    target.removeEventListener("focusout", hide);
    hide();
  };
}

export function applyWebpageTranslation(runtime, state, entry, translatedText, meta) {
  const common = {
    originalText: entry.text,
    translatedText: String(translatedText),
    sourceHash: meta.sourceHash,
    generation: meta.generation,
    pageKey: meta.pageKey
  };
  if (runtime.state.displayMode !== "bilingual") {
    entry.node.nodeValue = common.translatedText;
    state.nodeStore.set(entry.node, { ...common, renderKind: "replace" });
    return true;
  }
  const container = safeBilingualContainer(entry);
  if (container) {
    const translation = document.createElement("div");
    translation.className = "mt-webpage-bilingual-translation";
    translation.dataset.mangaTranslatorOverlay = "true";
    translation.textContent = common.translatedText;
    container.insertAdjacentElement("afterend", translation);
    state.nodeStore.set(entry.node, { ...common, renderKind: "block", insertedNode: translation });
    return true;
  }
  const target = entry.node.parentElement;
  if (!target) return false;
  const detach = attachTooltip(state, target, common.translatedText);
  state.nodeStore.set(entry.node, { ...common, renderKind: "tooltip", detach });
  return true;
}

export function cleanupWebpageEntry(node, entry, shouldRestore) {
  if (!entry) return false;
  if (entry.renderKind === "replace") {
    if (!shouldRestore(node, entry)) return false;
    node.nodeValue = entry.originalText;
  } else if (entry.renderKind === "block") {
    entry.insertedNode?.remove?.();
  } else if (entry.renderKind === "tooltip") {
    entry.detach?.();
  }
  return true;
}

/**
 * Progress panel driven by the active PageSession's three state axes:
 * 可视区 X/Y、页面后台 X/Y、待保存、真实失败。不再展示逐节点失败，避免
 * 把断开节点或保存失败误报成翻译失败。
 */
export function updateWebpageProgress(runtime, state) {
  const wrap = runtime.state.floatingBallWrap;
  if (!wrap?.isConnected) return;
  let panel = state.progressPanel;
  if (!panel?.isConnected) {
    panel = document.createElement("section");
    panel.className = "mt-webpage-progress-panel";
    panel.dataset.mangaTranslatorOverlay = "true";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    wrap.appendChild(panel);
    state.progressPanel = panel;
  }
  const session = state.session;
  const progress = session ? runtime.getVisibleWebpageProgress?.(session) : null;
  const busy = runtime.isWebpageQueueBusy?.() === true || state.working === true;
  const blocked = !!state.pageFault;
  const failed = (progress && progress.realFailed > 0) || state.partialFailure === true;
  const active = busy || blocked || failed || state.showTranslation === true;
  panel.hidden = !active;
  if (!active) return;
  panel.classList.toggle("mt-partial", failed || blocked);
  panel.classList.toggle("mt-complete", !busy && !failed && !blocked);
  const title = blocked ? "本地服务未启动，仅显示已缓存译文"
    : busy ? "网页持续翻译中" : failed ? "网页翻译部分完成" : "网页翻译完成";
  panel.textContent = "";
  const header = document.createElement("strong");
  header.textContent = title;
  const line = document.createElement("div");
  const parts = [];
  if (progress) {
    parts.push(`可视区 ${progress.viewportDone}/${progress.viewportTotal}`);
    parts.push(`页面后台 ${progress.backgroundDone}/${progress.backgroundTotal}`);
  }
  if (progress && progress.pendingSave > 0) parts.push(`待保存 ${progress.pendingSave}`);
  if (progress && progress.realFailed > 0) parts.push(`失败 ${progress.realFailed}`);
  if (blocked) parts.push("30 秒后自动重试");
  line.textContent = parts.length ? parts.join(" · ") : "正在扫描当前页面…";
  panel.append(header, line);
  if (!busy && !blocked) {
    clearTimeout(state.progressHideTimer);
    state.progressHideTimer = setTimeout(() => { panel.hidden = true; }, 4500);
  }
}
