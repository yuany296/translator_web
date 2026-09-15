/**
 * 侧边栏「章节译文修订面板」的定位控制器。
 *
 * 职责：接收「点原文 → 定位到该段落」的请求（两条路径：运行时广播 +
 * chrome.storage.session 焦点记录），等首次渲染完成后把目标卡片滚动到可视区
 * 居中并高亮，3 秒后自动淡出；点卡片 / 开始编辑 / 点面板其它处 / 手动滚动都会
 * 立即撤销；同一段重复触发则重新计时、始终最多只有一个高亮。
 *
 * 它同时负责向 background 注册一条长连接端口，让 background 能在同步阶段
 * 判定「本窗口的侧栏是否已经打开」——已开时 background 绝不重新打开面板
 * （重开会重载页面、丢掉未保存的编辑内容），只广播定位请求。
 */
const MT_FOCUS_HIGHLIGHT_MS = 3000;
const MT_FOCUS_SCROLL_SUPPRESS_MS = 700;
const MT_FOCUS_RECORD_TTL_MS = 60000;
const MT_NOVEL_PANEL_PORT = "mt-manage-panel";
const FOCUS_MESSAGE_TYPE = "FOCUS_NOVEL_REVISION_ITEM";

function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

export function installRevisionFocus(panel) {
  const { bodyEl, statusEl, searchInput, whenFirstRender } = panel;

  const pendingFocus = [];
  let highlightedCard = null;
  let highlightTimer = 0;
  let scrollSuppressUntil = 0;

  function cardFor(itemId) {
    const value = String(itemId || "");
    const escaped = globalThis.CSS?.escape ? CSS.escape(value) : value.replace(/["\\]/gu, "\\$&");
    return bodyEl.querySelector(`.card[data-item-id="${escaped}"]`) || null;
  }

  function cancelHighlight() {
    if (highlightTimer) {
      window.clearTimeout(highlightTimer);
      highlightTimer = 0;
    }
    if (highlightedCard) {
      highlightedCard.classList.remove("mt-focus");
      highlightedCard = null;
    }
  }

  function highlight(card) {
    if (highlightedCard && highlightedCard !== card) highlightedCard.classList.remove("mt-focus");
    highlightedCard = card;
    card.classList.add("mt-focus");
    if (highlightTimer) window.clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(() => {
      highlightTimer = 0;
      cancelHighlight();
    }, MT_FOCUS_HIGHLIGHT_MS);
  }

  /** 目标卡片被搜索词/折叠开关隐藏时滚动无效，需要先恢复全列表。 */
  function ensureCardVisible(card) {
    if (card.hidden !== true) return false;
    if (searchInput.value) searchInput.value = "";
    panel.setCollapseOnly(false);
    panel.applyFilter();
    statusEl.textContent = "已清除筛选以显示该段落";
    return true;
  }

  function applyFocus(itemId) {
    const card = cardFor(itemId);
    if (!card) return false;
    ensureCardVisible(card);
    // 程序化滚动也会触发 scroll 事件，短暂抑制，避免刚定位就被误判为手动滚动。
    scrollSuppressUntil = Date.now() + MT_FOCUS_SCROLL_SUPPRESS_MS;
    try {
      card.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    } catch {
      card.scrollIntoView();
    }
    highlight(card);
    return true;
  }

  function queueFocus(itemId) {
    const value = String(itemId || "").trim();
    if (!value) return;
    pendingFocus.push(value);
    void drainFocus();
  }

  async function drainFocus() {
    await whenFirstRender;
    while (pendingFocus.length) {
      applyFocus(pendingFocus.shift());
    }
  }

  // 撤销出口：点卡片、开始编辑、点面板其它处、手动滚动。
  bodyEl.addEventListener("click", () => cancelHighlight());
  bodyEl.addEventListener("input", event => {
    if (event.target && event.target.tagName === "TEXTAREA") cancelHighlight();
  });
  bodyEl.addEventListener("scroll", () => {
    if (Date.now() > scrollSuppressUntil) cancelHighlight();
  }, { passive: true });

  // 路径一：background 的运行时广播（侧栏已开着时走这条）。
  chrome.runtime.onMessage?.addListener((message, sender) => {
    if (!message || message.type !== FOCUS_MESSAGE_TYPE) return false;
    if (sender && sender.tab) return false; // 只接受 background 发出的广播
    const managed = panel.getManagedTabId();
    const target = Number(message.tabId);
    if (Number.isInteger(managed) && Number.isInteger(target) && managed !== target) {
      // 面板管理的是另一个标签页的章节：不静默切换（会丢未保存的编辑）。
      statusEl.textContent = "当前面板管理的是另一个标签页的章节";
      return false;
    }
    queueFocus(message.itemId);
    return false;
  });

  // 路径二：storage.session 的焦点记录（面板刚被打开、还没注册监听时走这条）。
  void (async () => {
    await whenFirstRender;
    try {
      const stored = await chrome.storage.session.get("mt_manage_focus");
      const record = stored && stored.mt_manage_focus;
      if (!record) return;
      await chrome.storage.session.remove("mt_manage_focus");
      if (Date.now() - Number(record.at || 0) > MT_FOCUS_RECORD_TTL_MS) return;
      const managed = panel.getManagedTabId();
      const target = Number(record.tabId);
      if (Number.isInteger(managed) && Number.isInteger(target) && managed !== target) {
        statusEl.textContent = "当前面板管理的是另一个标签页的章节";
        return;
      }
      queueFocus(record.itemId);
    } catch {
      // storage 不可用时跳过，不影响面板其余功能。
    }
  })();

  // 长连接端口：background 据此同步判定「本窗口侧栏是否已开」。
  try {
    const port = chrome.runtime.connect({ name: MT_NOVEL_PANEL_PORT });
    chrome.windows.getCurrent().then(win => {
      port.postMessage({ type: "mt-manage-panel-hello", windowId: win && win.id });
    }).catch(() => {});
  } catch {
    // 端口不可用时退化为仅 storage 路径；background 会多调一次 sidePanel.open。
  }

  return { queueFocus, drainFocus, cancelHighlight };
}
