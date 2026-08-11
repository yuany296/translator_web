function sendBackground(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (response && response.ok === false) reject(new Error(response.error || "操作失败"));
    else resolve(response || {});
  }));
}

async function sendTab(message) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error("找不到活动标签页");
  return await chrome.tabs.sendMessage(tabs[0].id, message);
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

  refreshBtn.addEventListener("click", () => void refresh());
  searchInput.addEventListener("input", () => applyFilter());
  collapseBtn.addEventListener("click", () => {
    collapseOnly = !collapseOnly;
    collapseBtn.textContent = collapseOnly ? "显示全部段落" : "仅显示有译文";
    applyFilter();
  });

  async function refresh() {
    refreshBtn.disabled = true;
    statusEl.textContent = "正在连接活动标签页…";
    try {
      const probe = await sendTab({ type: "PING_CONTENT_SCRIPT" }).catch(() => ({ ok: false }));
      if (!probe?.ok) {
        statusEl.textContent = "当前标签页未注入扩展内容，无法读取章节";
        bodyEl.replaceChildren();
        return;
      }
      const response = await sendTab({ type: "GET_NOVEL_CHAPTER_SNAPSHOT" });
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

    const sendAction = (action, payload = {}) => sendTab({
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
        const response = await sendBackground({
          type: "CONFIRM_TERM_CANDIDATES",
          entries: [{ source, target, note: noteInput.value.trim() }]
        });
        status.textContent = response.serverSynced === false
          ? `已加入本地术语表，但未能同步到服务（${response.serverError || "本地服务不可用"}）`
          : "已加入术语表（已同步服务端）";
        window.setTimeout(() => { termSectionWrap.hidden = true; }, 1200);
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
        const haystack = `${card.dataset.itemId || ""} ${card.textContent || ""}`.toLowerCase();
        match = match && haystack.includes(query);
      }
      card.hidden = !match;
    }
  }

  void refresh();
}