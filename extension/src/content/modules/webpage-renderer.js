const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "LI", "TD", "TH"]);
const INTERACTIVE_SELECTOR = "a,button,label,input,select,textarea,[role='button'],[role='link'],[role='menuitem'],[role='tab'],nav,menu";
const MAX_FAILURE_REASON = 160;

function safeBilingualContainer(entry) {
  const parent = entry?.node?.parentElement;
  if (!parent || !BLOCK_TAGS.has(String(parent.tagName || ""))) return null;
  if (parent.matches(INTERACTIVE_SELECTOR) || parent.querySelector(INTERACTIVE_SELECTOR)) return null;
  const childText = [...parent.childNodes].filter(node => node.nodeType === Node.TEXT_NODE
    && String(node.nodeValue || "").trim());
  return childText.length === 1 && childText[0] === entry.node ? parent : null;
}

/**
 * 双语模式的渲染：译文元素始终插在**原文字节点之后**。
 * 之前对「不在安全块级容器里」的段落（真实网页里的大多数：div/span/按钮/链接内的
 * 文字）退化成 hover 提示，用户不把鼠标移上去就看不到任何译文。现在两种情况都
 * 直接把译文写在原文后面，只是排版不同：
 *   - 段落是「只含这一段文字的块级元素」（p、h1-h6、li、td…）→ 块级排版，另起一行；
 *   - 其余（内联上下文）→ 行内排版，紧跟原文同一行。
 * 重复渲染幂等：同一节点同一条译文不会插第二份（菜单「重新显示译文」会重放期间）。
 */
function insertBilingualTranslation(state, entry, translatedText, info) {
  const container = safeBilingualContainer(entry);
  const parent = container || entry.node.parentElement;
  if (!parent) return null;
  const previous = state.nodeStore.get(entry.node);
  if (previous?.insertedNode?.isConnected) {
    if (previous.insertedNode.textContent === translatedText) {
      state.nodeStore.set(entry.node, { ...info, renderKind: previous.renderKind, insertedNode: previous.insertedNode });
      return previous.insertedNode;
    }
    previous.insertedNode.remove();
  }
  const element = document.createElement("span");
  element.className = container
    ? "mt-webpage-bilingual-translation mt-webpage-bilingual-block"
    : "mt-webpage-bilingual-translation mt-webpage-bilingual-inline";
  element.dataset.mangaTranslatorOverlay = "true";
  element.textContent = translatedText;
  parent.insertBefore(element, entry.node.nextSibling);
  state.nodeStore.set(entry.node, {
    ...info, renderKind: container ? "block" : "inline", insertedNode: element
  });
  return element;
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
  return Boolean(insertBilingualTranslation(state, entry, common.translatedText, common));
}

export function cleanupWebpageEntry(node, entry, shouldRestore) {
  if (!entry) return false;
  if (entry.renderKind === "replace") {
    if (!shouldRestore(node, entry)) return false;
    node.nodeValue = entry.originalText;
  } else if (entry.renderKind === "block" || entry.renderKind === "inline") {
    entry.insertedNode?.remove?.();
  }
  return true;
}

/**
 * 流式增量译文：模型每写完一行就先落地一行，不必等整批返回（慢模型整批要 20~30s）。
 * 只认当前任务的推送；重复推送同一行会被「已 done」跳过。最终结果仍会经
 * settleBatch 覆盖一次，所以这里即使解析偏了也会被最终译文修正。
 */
export function applyPartialWebpageTranslations(runtime, state, message = {}) {
  const session = state.session;
  if (!session) return 0;
  const taskId = String(message.taskId || "");
  if (taskId && state.taskId && taskId !== state.taskId) return 0;
  const entries = [];
  const translations = new Map();
  for (const row of Array.isArray(message.rows) ? message.rows : []) {
    const text = String(row && row.sourceText || "");
    const translated = String(row && row.translatedText || "");
    if (!text || !translated) continue;
    for (const segment of session.segments.values()) {
      if (segment.sourceText !== text || segment.status.translation === "done") continue;
      entries.push({
        node: segment.node, text, id: segment.segmentKey,
        sourceHash: segment.sourceHash, pageKey: session.pageKey
      });
      translations.set(text, translated);
    }
  }
  if (!entries.length) return 0;
  return runtime.applyWebpageEntriesToSession(session, state.generation, entries, translations);
}

/**
 * 首个失败原因：红 ↻ 图标的 title 只有悬停才看得到，把真实原因同时写进进度面板
 * 与控制台，用户不必猜「为什么总是失败」。
 */
function firstFailureReason(session) {
  if (!session) return "";
  for (const segment of session.segments.values()) {
    if (segment.status.translation !== "failed") continue;
    const reason = String(segment.errors?.[0]?.error || "").trim();
    if (reason) return reason.slice(0, MAX_FAILURE_REASON);
  }
  return "";
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
  // 只在进行中 / 失败 / 离线时显示状态栏；翻译完成（含原文保留）即隐藏，
  // 成功由图标旁的绿色勾勾表达，不再常驻“网页翻译完成”
  const active = busy || blocked || failed;
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
  if (progress && progress.unchangedCount > 0) parts.push(`原文保留 ${progress.unchangedCount}`);
  if (progress && progress.pendingSave > 0) parts.push(`待保存 ${progress.pendingSave}`);
  if (progress && progress.realFailed > 0) parts.push(`失败 ${progress.realFailed}`);
  if (blocked) parts.push("30 秒后自动重试");
  line.textContent = parts.length ? parts.join(" · ") : "正在扫描当前页面…";
  panel.append(header, line);
  const reason = failed && !blocked ? firstFailureReason(session) : "";
  if (reason) {
    const detail = document.createElement("div");
    detail.className = "mt-webpage-progress-reason";
    detail.textContent = `失败原因：${reason}`;
    panel.appendChild(detail);
    if (state.failureReasonLogged !== reason) {
      state.failureReasonLogged = reason;
      // 供用户/开发者取证：面板上只放一条，控制台留完整原因
      try {
        console.warn("[MangaTranslator] 网页翻译失败：", reason);
      } catch {
        // 无控制台环境（测试桩）忽略
      }
    }
  }
  if (!busy && !blocked && !failed) {
    clearTimeout(state.progressHideTimer);
    state.progressHideTimer = setTimeout(() => { panel.hidden = true; }, 4500);
  }
}
