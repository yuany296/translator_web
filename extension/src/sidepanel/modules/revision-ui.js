function sendBackground(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (response && response.ok === false) reject(new Error(response.error || "操作失败"));
    else resolve(response || {});
  }));
}

// 章节目标标签页的解析优先级:
//   1) URL ?tabId=(悬浮球回退为「新标签页打开」时显式指定)
//   2) chrome.storage.session 中 SW 打开侧栏前记录的来源标签页
//   3) 当前窗口的活动标签页
//   4) 扫描当前窗口所有标签页,找到能返回章节快照的小说页
// 解析结果固定复用,避免刷新/操作期间用户切换标签页导致目标漂移。
const TARGET_TAB_ID = (() => {
  const raw = new URLSearchParams(location.search).get("tabId");
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
})();

const MANAGE_TAB_KEY = "mt_manage_tab";

function isValidTabId(value) {
  return Number.isInteger(value) && value >= 0;
}

async function readManagedTabFromSession() {
  try {
    const record = await chrome.storage.session.get(MANAGE_TAB_KEY);
    const value = record && record[MANAGE_TAB_KEY];
    if (!value || !isValidTabId(value.tabId)) return null;
    const tab = await chrome.tabs.get(value.tabId).catch(() => null);
    if (!tab) return null;
    // 多窗口时,只在记录的窗口与侧栏所在窗口一致时才采用,
    // 避免在另一个窗口打开侧栏却去管理别的窗口的章节。
    const win = await chrome.windows.getCurrent();
    if (win && isValidTabId(value.windowId) && win.id !== value.windowId) return null;
    return value.tabId;
  } catch {
    return null;
  }
}

async function findNovelTabInWindow() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  for (const tab of tabs) {
    if (tab.id == null) continue;
    if (String(tab.url || "").startsWith("chrome")) continue;
    try {
      const probe = await chrome.tabs.sendMessage(tab.id, { type: "PING_CONTENT_SCRIPT" });
      if (!probe?.ok) continue;
      const snapshot = await chrome.tabs.sendMessage(tab.id, { type: "GET_NOVEL_CHAPTER_SNAPSHOT" });
      if (snapshot?.ok) return tab.id;
    } catch {
      // 该标签页没有可用的内容脚本
    }
  }
  return null;
}

async function resolveManagedTabId() {
  if (TARGET_TAB_ID !== null) return TARGET_TAB_ID;
  const sessionTabId = await readManagedTabFromSession();
  if (sessionTabId !== null) return sessionTabId;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id != null ? tabs[0].id : null;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "hidden") node.hidden = value;
    else if (key === "type") node.type = value;
    else if (key === "placeholder") node.placeholder = value;
    else if (key === "textContent") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === "string") node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

function actionButton(label, action, opts = {}) {
  const button = el("button", { type: "button", textContent: label });
  if (opts.danger) button.classList.add("danger");
  if (opts.primary) button.classList.add("primary");
  button.addEventListener("click", () => void action(button));
  return button;
}

function statusFromSnapshot(snapshot) {
  if (!snapshot) return "no";
  if (snapshot.activeVersion?.source === "manual") return "manual";
  if (snapshot.activeVersion?.pinned) return "pinned";
  if (snapshot.activeVersion?.configFingerprint
    && snapshot.activeVersion.configFingerprint !== snapshot.configFingerprint) return "stale";
  return "current";
}

export function installRevisionPanel() {
  const bodyEl = document.getElementById("body");
  const statusEl = document.getElementById("status");
  const searchInput = document.getElementById("search");
  const refreshBtn = document.getElementById("refreshBtn");
  const collapseBtn = document.getElementById("collapseBtn");

  let snapshot = null;
  let activeFingerprint = "";
  let collapseOnly = false;
  let managedTabId = TARGET_TAB_ID;

  // 首帧可等待点:定位请求必须等首次 render() 完成(卡片此时才存在),
  // 否则会出现「卡片还没渲染就滚动」的落空竞态。
  let resolveFirstRender = null;
  const whenFirstRender = new Promise(resolve => { resolveFirstRender = resolve; });

  const sendTabTo = (tabId, message) => chrome.tabs.sendMessage(tabId, message);

  refreshBtn.addEventListener("click", () => void refresh());
  searchInput.addEventListener("input", () => applyFilter());
  collapseBtn.addEventListener("click", () => {
    collapseOnly = !collapseOnly;
    collapseBtn.textContent = collapseOnly ? "显示全部段落" : "仅显示有译文";
    applyFilter();
  });

  async function refresh() {
    refreshBtn.disabled = true;
    statusEl.textContent = "正在连接小说章节…";
    try {
      if (managedTabId === null) {
        managedTabId = await resolveManagedTabId();
      }
      let probe = managedTabId !== null
        ? await sendTabTo(managedTabId, { type: "PING_CONTENT_SCRIPT" }).catch(() => ({ ok: false }))
        : { ok: false };
      if (!probe?.ok && managedTabId !== null) {
        // 目标标签页内容脚本未响应(常见于扩展刚重新加载),
        // 尝试扫描窗口内其他小说标签页。
        const found = await findNovelTabInWindow();
        if (found !== null && found !== managedTabId) {
          managedTabId = found;
          probe = await sendTabTo(managedTabId, { type: "PING_CONTENT_SCRIPT" }).catch(() => ({ ok: false }));
        }
      }
      if (!probe?.ok) {
        statusEl.textContent = managedTabId !== null
          ? "已找到小说章节标签页，但内容脚本未响应（扩展可能刚重新加载）。请刷新该标签页后重试。"
          : "未找到小说章节标签页。请先打开 Kakao 小说页面，再点「管理当前章节译文」。";
        bodyEl.replaceChildren();
        return;
      }
      const response = await sendTabTo(managedTabId, { type: "GET_NOVEL_CHAPTER_SNAPSHOT" });
      if (!response?.ok) {
        statusEl.textContent = response?.error || "当前页面不是可管理的小说章节";
        bodyEl.replaceChildren();
        return;
      }
      snapshot = response;
      activeFingerprint = response.fingerprint || "";
      statusEl.textContent = response.service?.ok
        ? (response.service.pendingConflicts
          ? `有 ${response.service.pendingConflicts} 个离线操作待确认；所有正式版本以本地服务为准`
          : "SQLite 在线；所有正式版本以本地服务为准")
        : "本地服务未启动；编辑将进入待提交队列";
      render();
    } catch (error) {
      statusEl.textContent = error.message;
      bodyEl.replaceChildren();
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function render() {
    renderCards();
    // 首帧完成:此后到达的定位请求都可以安全地查找卡片。
    if (resolveFirstRender) {
      resolveFirstRender();
      resolveFirstRender = null;
    }
  }

  function renderCards() {
    bodyEl.replaceChildren();
    const items = snapshot?.items || [];
    if (!items.length) {
      bodyEl.appendChild(el("div", { class: "empty", textContent: "当前章节没有已翻译段落，请先发起翻译。" }));
      return;
    }
    for (const item of items) bodyEl.appendChild(renderCard(item));
    applyFilter();
  }

  function renderCard(item) {
    const status = statusFromSnapshot({ ...item.snapshot, configFingerprint: activeFingerprint });
    const editor = el("textarea", {});
    editor.value = item.translatedText || "";
    const instruction = el("input", { type: "text", class: "meta-input", placeholder: "给 AI 的单轮修订指令（可选）" });

    const run = async (button, task) => {
      button.disabled = true;
      try {
        const result = await task();
        await refresh();
        return result;
      } catch (error) {
        statusEl.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };

    const sendAction = (action, payload = {}) => sendTabTo(managedTabId, {
      type: "NOVEL_REVISION_ACTION", action, payload: { itemId: item.id, ...payload }
    });

    const actions = el("div", { class: "actions" }, [
      actionButton("保存修改", b => run(b, () => sendAction("edit", { translatedText: editor.value })), { primary: true }),
      actionButton("重新翻译", b => run(b, () => sendAction("retranslate"))),
      actionButton("AI 修订", b => run(b, () => sendAction("aiRevise", { instruction: instruction.value }))),
      actionButton("删除", b => run(b, () => sendAction("delete")), { danger: true }),
      actionButton("＋ 术语", () => { termSection.hidden = !termSection.hidden; }),
    ]);

    const termSection = renderTermSection(item, editor);
    termSection.hidden = true;

    const versions = el("div", { class: "versions" });
    for (const version of item.snapshot?.recentVersions || []) {
      versions.appendChild(el("div", { class: "version-row" }, [
        el("span", { textContent: `${version.source}${version.pinned ? " · pinned" : ""} · ${new Date(version.createdAt).toLocaleString()}` }),
        actionButton("选择", b => run(b, () => sendAction("selectVersion", { versionId: version.versionId }))),
        actionButton("固定", b => run(b, () => sendAction("selectVersion", { versionId: version.versionId, pinned: true }))),
      ]));
    }

    return el("section", { class: "card", dataset: { itemId: item.id } }, [
      el("span", { class: "badge", dataset: { status }, textContent: status }),
      el("div", { class: "source", textContent: item.originalText }),
      editor,
      instruction,
      actions,
      termSection,
      versions,
    ]);
  }

  function renderTermSection(item, editor) {
    const sourceInput = el("input", { type: "text", placeholder: "韩文原文（AI 提取后自动填入，可修改）", maxlength: "120" });
    const targetInput = el("input", { type: "text", placeholder: "固定译文", maxlength: "120" });
    const noteInput = el("input", { type: "text", placeholder: "备注（可选）", maxlength: "240" });
    const status = el("div", { class: "term-status" });
    const selectedText = () => {
      const start = editor.selectionStart || 0;
      const end = editor.selectionEnd || 0;
      return start === end ? "" : editor.value.slice(start, end).trim();
    };

    const extractBtn = actionButton("提取韩文原文", () => void (async () => {
      const target = targetInput.value.trim() || selectedText();
      if (!target) { status.textContent = "请先填写固定译文，或在译文框中选中文字"; return; }
      targetInput.value = target;
      extractBtn.disabled = true;
      status.textContent = "正在提取韩文原文…";
      try {
        const response = await sendBackground({
          type: "EXTRACT_TERM_FROM_CONTEXT",
          sourceText: String(item.originalText),
          translatedText: editor.value.trim(),
          selectedText: target,
          targetLanguage: snapshot?.chapter?.targetLanguage || "zh-CN"
        });
        sourceInput.value = response.term || "";
        status.textContent = response.foundInSource
          ? "已提取韩文原文，请核对"
          : "提取结果未能与原文完全匹配，请核对后修正";
      } catch (error) {
        status.textContent = `${error.message}（可手动填写原文）`;
      } finally {
        extractBtn.disabled = false;
      }
    })());

    const confirmBtn = actionButton("加入术语表", () => void (async () => {
      const source = sourceInput.value.trim();
      const target = targetInput.value.trim() || selectedText();
      if (!source || !target) { status.textContent = "原文术语和固定译文都不能为空"; return; }
      targetInput.value = target;
      confirmBtn.disabled = true;
      try {
        // 带上本页地址：术语库按网址绑定归属，后台据此把术语放进「本网址的库」。
        // 只发 source/target 的话后台认不出这一页，一律落到默认术语库。
        // chapterKey 与候选提取用的是同一个值（章节页地址），手动指定过库的章节才认得出来。
        const pageUrl = String(snapshot?.chapter?.url || "");
        const response = await sendBackground({
          type: "CONFIRM_TERM_CANDIDATES",
          entries: [{ source, target, note: noteInput.value.trim(), pageUrl, chapterKey: pageUrl }]
        });
        const libraryName = (response.libraryNames || []).filter(Boolean).join("、");
        const where = libraryName ? `术语库「${libraryName}」` : "术语表";
        status.textContent = response.serverSynced === false
          ? `已加入${where}，但未能同步到服务（${response.serverError || "本地服务不可用"}）`
          : `已加入${where}（已同步服务端）`;
        window.setTimeout(() => { termSectionWrap.hidden = true; }, 2600);
      } catch (error) {
        status.textContent = `加入失败：${error.message}`;
      } finally {
        confirmBtn.disabled = false;
      }
    })(), { primary: true });

    const cancelBtn = actionButton("取消", () => { termSectionWrap.hidden = true; });
    const termActions = el("div", { class: "term-actions" }, [extractBtn, confirmBtn, cancelBtn]);
    const termSectionWrap = el("div", { class: "term-section" }, [
      sourceInput, targetInput, noteInput, status, termActions
    ]);
    return termSectionWrap;
  }

  function applyFilter() {
    const query = (searchInput.value || "").trim().toLowerCase();
    for (const card of bodyEl.querySelectorAll(".card")) {
      let match = true;
      if (collapseOnly) {
        const editor = card.querySelector("textarea");
        match = match && !!(editor && editor.value.trim());
      }
      if (query) {
        const editor = card.querySelector("textarea");
        const source = card.querySelector(".source");
        const haystack = `${card.dataset.itemId || ""} ${card.textContent || ""} ${source?.textContent || ""} ${editor?.value || ""}`.toLowerCase();
        match = match && haystack.includes(query);
      }
      card.hidden = !match;
    }
  }

  void refresh();

  // 交由 revision-focus 控制器消费:定位/滚动/高亮/清筛选都在那边实现,
  // 这里只暴露内部依赖(避免把 revision-ui 顶破行数门禁)。
  return {
    bodyEl,
    statusEl,
    searchInput,
    collapseBtn,
    applyFilter,
    setCollapseOnly(value) {
      collapseOnly = value === true;
      collapseBtn.textContent = collapseOnly ? "显示全部段落" : "仅显示有译文";
    },
    getCollapseOnly: () => collapseOnly,
    whenFirstRender,
    getManagedTabId: () => managedTabId,
    setManagedTabId: value => { managedTabId = value; },
    requestRefresh: () => refresh()
  };
}