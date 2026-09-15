/**
 * 术语批量操作：复选框多选、批量移动到其他术语库、批量删除。
 *
 * 选中集合是模块级 Set（存条目 id），筛选条件变化时按 id 天然保留；
 * 执行批量操作前先过滤掉已不存在于 glossary.entries 的 id（外部刷新可能改了数据）。
 * 渲染同步通过包装 runtime.renderGlossary 实现：行重建后恢复复选框勾选状态、
 * 修剪失效 id、同步表头全选框与批量操作栏，不侵入 glossary-terms-view 的渲染逻辑。
 */
export function installGlossaryBatchActions(runtime) {
  const selectAllInput = document.getElementById("selectAllTerms");
  const actionBar = document.getElementById("batchActionBar");
  const countText = document.getElementById("batchSelectedCount");
  const modeBtn = document.getElementById("batchModeBtn");
  const tableContainer = document.getElementById("tableContainer");
  const moveBtn = document.getElementById("batchMoveBtn");
  const deleteBtn = document.getElementById("batchDeleteBtn");
  const clearBtn = document.getElementById("batchClearBtn");
  const moveDialog = document.getElementById("batchMoveDialog");
  const moveForm = document.getElementById("batchMoveForm");
  const moveTargetSelect = document.getElementById("batchMoveTargetSelect");
  const moveCancelBtn = document.getElementById("batchMoveCancel");

  // 页面缺少这套控件（旧构建/被裁剪）时整个模块保持惰性，单条编辑/删除不受影响。
  if (!runtime.termRows || !runtime.renderGlossary || !selectAllInput
    || !actionBar || !countText || !moveDialog || !moveForm || !moveTargetSelect) {
    return;
  }

  const selectedIds = new Set();
  let moveRequest = null;
  // 批量模式：平时藏掉行首复选框列，点工具栏「批量操作」才进入（用户嫌入口不明显）。
  let batchMode = false;

  function entryById(id) {
    return runtime.glossary.entries.find(entry => entry.id === id) || null;
  }

  function visibleRowIds() {
    // termRows.children 在浏览器里是 HTMLCollection：没有 .map，也不能用 [...] 展开，必须 Array.from。
    // 少了这一步，每次渲染后的同步都会抛 TypeError，把它后面的「进入术语库」之类跳转一起打断。
    return Array.from(runtime.termRows.children)
      .map(row => (row.dataset ? row.dataset.termId : ""))
      .filter(Boolean);
  }

  /** 修剪掉已不存在于 entries 的 id（storage 外部刷新可能删了条目）。 */
  function pruneSelection() {
    for (const id of [...selectedIds]) {
      if (!entryById(id)) {
        selectedIds.delete(id);
      }
    }
  }

  function updateActionBar() {
    pruneSelection();
    // 批量模式下即使一条没选也显示这条栏（否则用户不知道下一步该干什么）；
    // 非批量模式保持老行为：只有选中了才出现。
    actionBar.classList.toggle("hidden", selectedIds.size === 0 && !batchMode);
    countText.textContent = batchMode && selectedIds.size === 0
      ? "已选 0 条 · 勾选下面要处理的术语"
      : `已选 ${selectedIds.size} 条`;
  }

  function updateSelectAllState() {
    pruneSelection();
    const visible = visibleRowIds();
    selectAllInput.checked = visible.length > 0
      && visible.every(id => selectedIds.has(id));
  }

  /** 每次渲染（含 persistEntries 触发的）之后同步复选框状态与批量栏。 */
  function syncAfterRender() {
    updateSelectAllState();
    updateActionBar();
  }

  function clearSelection(options = {}) {
    // 事件处理器会把 Event 当第一个参数传进来，所以这里只认显式的 { rerender:false }。
    const rerender = !(options && options.rerender === false);
    selectedIds.clear();
    updateSelectAllState();
    updateActionBar();
    // 全量重建 tbody，把行内复选框恢复成未勾选。
    if (rerender) {
      runtime.renderGlossary();
    }
  }
  runtime.clearBatchSelection = clearSelection;

  function createTermSelectCell(entry) {
    const cell = document.createElement("td");
    // col-select：非批量模式下整列藏起来（CSS 见 glossary.html）
    cell.className = "col-select";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "term-select";
    checkbox.dataset.action = "select-term";
    checkbox.checked = selectedIds.has(entry.id);
    checkbox.setAttribute("aria-label", `选择 ${entry.source}`);
    cell.append(checkbox);
    return cell;
  }
  runtime.createTermSelectCell = createTermSelectCell;

  // 行内复选框 change：与 handleRowToggle（只处理 action=toggle）互不干扰。
  function handleSelectChange(event) {
    if (!event.target || event.target.dataset.action !== "select-term") {
      return;
    }
    const row = event.target.closest("tr[data-term-id]");
    if (!row) {
      return;
    }
    if (event.target.checked) {
      selectedIds.add(row.dataset.termId);
    } else {
      selectedIds.delete(row.dataset.termId);
    }
    updateSelectAllState();
    updateActionBar();
  }

  // 表头全选只作用于当前筛选可见的行。
  function handleSelectAllChange() {
    const ids = visibleRowIds();
    for (const id of ids) {
      if (selectAllInput.checked) {
        selectedIds.add(id);
      } else {
        selectedIds.delete(id);
      }
    }
    updateActionBar();
  }

  function openMoveDialog() {
    const ids = validSelectionIds();
    if (!ids.length) {
      clearSelection();
      return;
    }
    moveRequest = ids;
    runtime.fillLibraryOptions(moveTargetSelect, "");
    moveDialog.showModal();
  }

  /** 执行操作前过滤掉已不存在于 entries 的 id。 */
  function validSelectionIds() {
    return [...selectedIds].filter(id => entryById(id));
  }

  function describeSkips(duplicate, capacity) {
    const skipped = duplicate + capacity;
    if (!skipped) {
      return "";
    }
    const parts = [];
    if (duplicate) {
      parts.push(`重复 ${duplicate}`);
    }
    if (capacity) {
      parts.push(`容量 ${capacity}`);
    }
    return `，跳过 ${skipped} 条（${parts.join(" / ")}）`;
  }

  async function executeMove() {
    const ids = moveRequest ? moveRequest.filter(id => entryById(id)) : [];
    moveRequest = null;
    const targetId = moveTargetSelect.value || runtime.glossaryCore.DEFAULT_LIBRARY_ID;
    if (moveDialog.open) {
      moveDialog.close();
    }
    if (!ids.length) {
      clearSelection();
      return;
    }
    const targetName = runtime.glossaryCore.getLibraryName(runtime.glossary, targetId);
    if (!runtime.glossary.libraries.some(library => library.id === targetId)) {
      runtime.setStatus(`目标术语库「${targetName}」不存在`, true);
      clearSelection();
      return;
    }
    // 跳过规则：目标库已有 (source, sourceLanguage, targetLanguage, scope, scopeKey)
    // 完全相同的条目 → 重复跳过；目标库达到 MAX_ENTRIES_PER_LIBRARY → 容量跳过。
    const moveKey = entry => [
      entry.source, entry.sourceLanguage, entry.targetLanguage, entry.scope, entry.scopeKey
    ].join("\u0000");
    const targetEntries = runtime.glossary.entries.filter(entry => entry.libraryId === targetId);
    const targetKeys = new Set(targetEntries.map(moveKey));
    let capacity = runtime.glossaryCore.MAX_ENTRIES_PER_LIBRARY - targetEntries.length;
    const movedIds = new Set();
    let skippedDuplicate = 0;
    let skippedCapacity = 0;
    for (const id of ids) {
      const entry = entryById(id);
      if (!entry) {
        continue;
      }
      if (targetKeys.has(moveKey(entry))) {
        skippedDuplicate += 1;
        continue;
      }
      if (capacity <= 0) {
        skippedCapacity += 1;
        continue;
      }
      targetKeys.add(moveKey(entry));
      capacity -= 1;
      movedIds.add(id);
    }
    const skipDetail = describeSkips(skippedDuplicate, skippedCapacity);
    clearSelection();
    if (!movedIds.size) {
      runtime.setStatus(`没有术语移动到「${targetName}」${skipDetail}`, true);
      return;
    }
    const nextEntries = runtime.glossary.entries.map(entry =>
      movedIds.has(entry.id) ? { ...entry, libraryId: targetId } : entry);
    await runtime.persistEntries(nextEntries,
      `已移动 ${movedIds.size} 条到「${targetName}」${skipDetail}`);
  }

  async function executeDelete() {
    const ids = validSelectionIds();
    if (!ids.length) {
      clearSelection();
      return;
    }
    if (!confirm(`确定删除选中的 ${ids.length} 条术语吗？`)) {
      return;
    }
    const idSet = new Set(ids);
    const nextEntries = runtime.glossary.entries.filter(entry => !idSet.has(entry.id));
    clearSelection();
    await runtime.persistEntries(nextEntries, `已删除 ${ids.length} 条术语`);
  }

  /**
   * 进入/退出批量模式。退出时清空已选：不然收起了复选框列还留着选择，
   * 下次点「删除」会删掉看不见的东西。
   */
  function setBatchMode(on) {
    const next = Boolean(on) && Boolean(modeBtn);
    const hadSelection = selectedIds.size > 0;
    batchMode = next;
    if (!next) {
      selectedIds.clear();
    }
    if (modeBtn) {
      modeBtn.classList.toggle("active", batchMode);
      modeBtn.textContent = batchMode ? "退出批量" : "批量操作";
      modeBtn.setAttribute("aria-pressed", String(batchMode));
    }
    tableContainer?.classList.toggle("batch-mode", batchMode);
    syncAfterRender();
    if (!next && hadSelection) {
      // 行内复选框的勾选状态只能靠重渲染复位。
      runtime.renderGlossary();
    }
  }
  runtime.setBatchMode = setBatchMode;
  runtime.isBatchMode = () => batchMode;

  // 切到「待确认」tab 时退出批量模式（批量操作只作用于正式术语）。
  function handleTabSwitch(tab) {
    if (tab !== "official") {
      setBatchMode(false);
    }
  }
  runtime.handleGlossaryTabSwitch = handleTabSwitch;

  const previousRender = runtime.renderGlossary;
  runtime.renderGlossary = (...args) => {
    const result = previousRender(...args);
    syncAfterRender();
    return result;
  };

  runtime.termRows.addEventListener("change", handleSelectChange);
  selectAllInput.addEventListener("change", handleSelectAllChange);
  if (modeBtn) {
    // batch-capable：有这个按钮才启用「平时藏复选框列」的样式，缺控件时表格保持原样。
    tableContainer?.classList.add("batch-capable");
    // 文案由模块自己写：单一真源，退出/进入批量时不会和 HTML 里的初始值打架。
    modeBtn.textContent = "批量操作";
    modeBtn.setAttribute("aria-pressed", "false");
    modeBtn.addEventListener("click", () => setBatchMode(!batchMode));
  }
  moveBtn.addEventListener("click", openMoveDialog);
  deleteBtn.addEventListener("click", () => void executeDelete());
  clearBtn.addEventListener("click", clearSelection);
  moveForm.addEventListener("submit", event => {
    event.preventDefault();
    void executeMove();
  });
  moveCancelBtn?.addEventListener("click", () => {
    moveRequest = null;
    if (moveDialog.open) {
      moveDialog.close();
    }
  });
  // Esc / 点遮罩关闭 dialog：视为放弃本次移动。
  moveDialog.addEventListener("close", () => {
    moveRequest = null;
  });
}
