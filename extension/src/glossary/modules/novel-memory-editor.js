export function installNovelMemoryEditor(runtime) {
  // 术语库页已经不再有「小说记忆」标签（入口搬去设置页的分区），所以这里必须容忍它不存在。
  const memoryTabBtn = document.getElementById("memoryTabBtn");
  const memoryPanel = document.getElementById("memoryPanel");
  const memoryBookSelect = document.getElementById("memoryBookSelect");
  const memoryChapterSelect = document.getElementById("memoryChapterSelect");
  const memoryJsonInput = document.getElementById("memoryJsonInput");
  const memoryMetaText = document.getElementById("memoryMetaText");
  const memoryDeltaText = document.getElementById("memoryDeltaText");
  const memoryStatusText = document.getElementById("memoryStatusText");
  const memorySaveBtn = document.getElementById("memorySaveBtn");
  const memoryExportBtn = document.getElementById("memoryExportBtn");
  const memoryImportBtn = document.getElementById("memoryImportBtn");
  const memoryClearBtn = document.getElementById("memoryClearBtn");
  const memoryDeleteChapterBtn = document.getElementById("memoryDeleteChapterBtn");
  const memoryClearAllBtn = document.getElementById("memoryClearAllBtn");
  const memoryFileInput = document.getElementById("memoryFileInput");
  let store = runtime.novelMemoryCore.normalizeStore(null);

  function switchTab(tab) {
    runtime.activeTab = ["official", "pending", "memory"].includes(tab) ? tab : "official";
    const official = runtime.activeTab === "official";
    const pending = runtime.activeTab === "pending";
    runtime.officialPanel.classList.toggle("hidden", !official);
    runtime.pendingPanel.classList.toggle("hidden", !pending);
    memoryPanel.classList.toggle("hidden", runtime.activeTab !== "memory");
    runtime.officialTabBtn.classList.toggle("active", official);
    runtime.pendingTabBtn.classList.toggle("active", pending);
    memoryTabBtn?.classList.toggle("active", runtime.activeTab === "memory");
    runtime.addBtn.classList.toggle("hidden", !official);
    if (pending) runtime.loadTermDiscoveryState(true).catch(error => {
      runtime.setPendingStatus(`读取失败：${runtime.getErrorMessage(error)}`, true);
    });
    if (runtime.activeTab === "memory") void loadNovelMemory();
    // 切换 tab 时通知批量操作模块（只在正式术语 tab 有效）。
    runtime.handleGlossaryTabSwitch?.(runtime.activeTab);
  }
  runtime.switchTab = switchTab;

  async function loadNovelMemory() {
    const response = await runtime.sendRuntimeMessage({ type: "GET_NOVEL_MEMORY" });
    if (!response?.ok) throw new Error(response?.error || "读取小说记忆失败");
    store = runtime.novelMemoryCore.normalizeStore(response.store);
    await renderBookOptions();
  }

  /** 一条快照的显示名：第 N 话（序号没认出来就说清楚）+ 章节标题 + 修订号。 */
  function chapterLabel(checkpoint) {
    const order = runtime.novelMemoryCore.checkpointOrder(checkpoint.chapterOrder);
    const name = order !== null ? `第 ${order} 话` : "话号未识别";
    const title = checkpoint.chapterTitle ? ` · ${checkpoint.chapterTitle}` : "";
    return `${name}${title} · 修订 ${checkpoint.revision}`;
  }
  runtime.memoryChapterLabel = chapterLabel;

  /** 浏览器里正开着的那一话：用来把编辑对象默认对齐到「你现在在读的那一话」。 */
  async function detectOpenChapterId(book) {
    try {
      const tabs = await chrome.tabs.query({ url: "https://page.kakao.com/*" });
      const opened = (Array.isArray(tabs) ? tabs : []).filter(tab => tab && tab.url);
      const tab = opened.find(item => item.active)
        || opened.sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0))[0];
      const match = String(tab?.url || "").match(/\/content\/([^/]+)\/viewer\/([^/?#]+)/u);
      if (!match) {
        return "";
      }
      // 只认同一本书的章节页，免得把别的作品的话号套过来
      return !book || book.key === `kakao:${match[1]}` ? match[2] : "";
    } catch (_) {
      return "";
    }
  }

  async function renderBookOptions(preferredKey = "") {
    const selected = preferredKey || memoryBookSelect.value;
    memoryBookSelect.replaceChildren(...store.books.map(book => {
      const option = document.createElement("option");
      option.value = book.key;
      option.textContent = book.title || book.key;
      return option;
    }));
    // 浏览器里塞进 option 后 select 会自动选第一条；这里显式指定，行为不依赖浏览器的隐式选择。
    memoryBookSelect.value = store.books.some(book => book.key === selected)
      ? selected : (store.books[0] ? store.books[0].key : "");
    renderChapterOptions(await detectOpenChapterId(getSelectedBook()));
  }

  /** 没有明确选中时的默认话：优先序号最大的那一话（进度），其次最后写入的那一条。 */
  function defaultChapterId(checkpoints) {
    const latestOrdered = [...checkpoints].reverse()
      .find(item => runtime.novelMemoryCore.checkpointOrder(item.chapterOrder) !== null);
    return (latestOrdered || checkpoints.at(-1)).chapterId;
  }

  function renderChapterOptions(preferredChapterId = "") {
    const book = getSelectedBook();
    const checkpoints = book ? book.checkpoints : [];
    const wanted = preferredChapterId || memoryChapterSelect.value;
    memoryChapterSelect.replaceChildren(...checkpoints.map(checkpoint => {
      const option = document.createElement("option");
      option.value = checkpoint.chapterId;
      option.textContent = chapterLabel(checkpoint);
      return option;
    }));
    if (checkpoints.length) {
      // 认出「正在读的那一话」就用它，否则退回序号最大的那一话（= 最后读到的进度）。
      memoryChapterSelect.value = checkpoints.some(item => item.chapterId === wanted)
        ? wanted : defaultChapterId(checkpoints);
    }
    renderSelectedCheckpoint();
  }
  runtime.renderChapterOptions = renderChapterOptions;

  function getSelectedBook() {
    return store.books.find(book => book.key === memoryBookSelect.value) || null;
  }

  /** 当前编辑的那一话：明确选中的那一条，退路是序号最大的那一条。 */
  function getSelectedCheckpoint() {
    const book = getSelectedBook();
    if (!book) {
      return null;
    }
    return book.checkpoints.find(item => item.chapterId === memoryChapterSelect.value)
      || book.checkpoints.at(-1) || null;
  }
  runtime.getSelectedCheckpoint = getSelectedCheckpoint;

  /** 「本话新增」的一句话描述：让每一话的贡献能单独看出来（不用去 diff 两份累计 JSON）。 */
  function describeDelta(delta) {
    if (!delta) {
      return "本话新增：（这条是旧版存的累计记忆，没有单独记录本话新增；重翻一次这一话就会补上）";
    }
    const parts = [];
    const names = (Array.isArray(delta.characters) ? delta.characters : [])
      .map(item => (typeof item === "string" ? item : item && (item.name || item.source || item.target)))
      .filter(Boolean);
    if (names.length) {
      parts.push(`角色 ${names.slice(0, 6).join("、")}${names.length > 6 ? ` 等 ${names.length} 个` : ""}`);
    }
    const counts = [
      ["relationships", "关系"], ["honorifics", "称呼"], ["unresolved", "待解"]
    ];
    for (const [key, label] of counts) {
      const count = (Array.isArray(delta[key]) ? delta[key] : []).length;
      if (count) {
        parts.push(`${label} ${count} 条`);
      }
    }
    if (delta.summary) {
      parts.push("剧情摘要");
    }
    return `本话新增：${parts.length ? parts.join(" / ") : "无"}`;
  }
  runtime.memoryDeltaLabel = describeDelta;

  function renderSelectedCheckpoint() {
    const book = getSelectedBook();
    const checkpoint = getSelectedCheckpoint();
    memoryJsonInput.disabled = !checkpoint;
    memorySaveBtn.disabled = !checkpoint;
    memoryExportBtn.disabled = !book;
    memoryClearBtn.disabled = !book;
    memoryDeleteChapterBtn.disabled = !checkpoint;
    memoryClearAllBtn.disabled = store.books.length === 0;
    memoryJsonInput.value = checkpoint ? JSON.stringify(checkpoint.memory, null, 2) : "";
    memoryMetaText.textContent = checkpoint
      ? `${book.title || book.key} · ${chapterLabel(checkpoint)}`
      : "暂无小说记忆";
    memoryDeltaText.textContent = checkpoint ? describeDelta(checkpoint.delta) : "本话新增：—";
  }
  runtime.renderSelectedCheckpoint = renderSelectedCheckpoint;

  function renderSelectedBook() {
    renderSelectedCheckpoint();
  }

  function setStatus(message, error = false) {
    memoryStatusText.textContent = message;
    memoryStatusText.dataset.error = error ? "true" : "false";
  }

  async function saveSelectedMemory() {
    const book = getSelectedBook();
    const checkpoint = getSelectedCheckpoint();
    if (!book || !checkpoint) return;
    try {
      const memory = runtime.novelMemoryCore.normalizeMemory(JSON.parse(memoryJsonInput.value));
      const response = await runtime.sendRuntimeMessage({
        type: "SAVE_NOVEL_MEMORY",
        scopeKey: book.key,
        seriesId: book.seriesId,
        seriesTitle: book.title,
        chapterId: checkpoint.chapterId,
        chapterTitle: checkpoint.chapterTitle,
        chapterOrder: checkpoint.chapterOrder,
        memory
      });
      if (!response?.ok) throw new Error(response?.error || "保存失败");
      const order = runtime.novelMemoryCore.checkpointOrder(checkpoint.chapterOrder);
      setStatus(`已保存 ${order !== null ? `第 ${order} 话` : "选中这一话"} 的记忆`);
      await loadNovelMemory();
    } catch (error) {
      setStatus(`保存失败：${runtime.getErrorMessage(error)}`, true);
    }
  }

  function exportSelectedBook() {
    const book = getSelectedBook();
    if (!book) return;
    runtime.downloadFile(
      `novel-memory-${book.seriesId || "book"}-${runtime.formatDate()}.json`,
      JSON.stringify(book, null, 2),
      "application/json;charset=utf-8"
    );
    setStatus("本书记忆已导出");
  }

  async function importBookFile() {
    const file = memoryFileInput.files?.[0];
    memoryFileInput.value = "";
    if (!file) return;
    try {
      const book = runtime.novelMemoryCore.normalizeStore({
        books: [JSON.parse(await file.text())]
      }).books[0];
      if (!book || !book.checkpoints.length) throw new Error("文件中没有有效的作品记忆");
      for (const checkpoint of book.checkpoints) {
        const response = await runtime.sendRuntimeMessage({
          type: "SAVE_NOVEL_MEMORY",
          scopeKey: book.key,
          seriesId: book.seriesId,
          seriesTitle: book.title,
          chapterId: checkpoint.chapterId,
          chapterTitle: checkpoint.chapterTitle,
          chapterOrder: checkpoint.chapterOrder,
          memory: checkpoint.memory
        });
        if (!response?.ok) throw new Error(response?.error || "导入失败");
      }
      setStatus("本书记忆已导入");
      await loadNovelMemory();
      await renderBookOptions(book.key);
    } catch (error) {
      setStatus(`导入失败：${runtime.getErrorMessage(error)}`, true);
    }
  }

  /** 只清选中这一话的快照：回顾时发现这一话的累计混了后面的内容，就清掉它重翻重建。 */
  async function deleteSelectedCheckpoint() {
    const book = getSelectedBook();
    const checkpoint = getSelectedCheckpoint();
    if (!book || !checkpoint) return;
    const order = runtime.novelMemoryCore.checkpointOrder(checkpoint.chapterOrder);
    const label = order !== null ? `第 ${order} 话` : "选中这一话";
    if (!confirm(`清掉${label}的记忆快照？其它话不受影响；这一话之后重翻会重新累积。`)) return;
    const response = await runtime.sendRuntimeMessage({
      type: "DELETE_NOVEL_MEMORY_CHAPTER",
      scopeKey: book.key,
      chapterId: checkpoint.chapterId
    });
    if (!response?.ok) {
      setStatus(response?.error || "删除失败", true);
      return;
    }
    setStatus(`已清掉${label}的记忆`);
    await loadNovelMemory();
  }

  /** 清空所有作品的小说记忆：旧数据已经被旧版缺陷污染过时，这是最省事的重来方式。 */
  async function clearAllMemory() {
    if (!store.books.length) {
      setStatus("现在没有任何小说记忆", true);
      return;
    }
    if (!confirm(`清空全部 ${store.books.length} 部作品的小说记忆？不可撤销，需要的作品请先「导出本书」备份。`)) return;
    const response = await runtime.sendRuntimeMessage({ type: "CLEAR_NOVEL_MEMORY" });
    if (!response?.ok) {
      setStatus(response?.error || "清空失败", true);
      return;
    }
    setStatus("已清空全部小说记忆");
    await loadNovelMemory();
  }

  async function clearSelectedBook() {
    const book = getSelectedBook();
    if (!book || !confirm(`确定清空《${book.title || book.key}》的全部小说记忆吗？`)) return;
    const response = await runtime.sendRuntimeMessage({
      type: "CLEAR_NOVEL_MEMORY",
      scopeKey: book.key
    });
    if (!response?.ok) {
      setStatus(response?.error || "清空失败", true);
      return;
    }
    setStatus("本书记忆已清空");
    await loadNovelMemory();
  }

  document.addEventListener("DOMContentLoaded", () => {
    memoryTabBtn?.addEventListener("click", () => runtime.switchTab("memory"));
    // 直接以 ?view=memory 打开（设置页的分区）时，安装阶段那次请求可能早于后台就绪，这里兜底刷一次。
    if (runtime.activeTab === "memory") void loadNovelMemory();
    memoryBookSelect.addEventListener("change", () => void renderBookOptions());
    memoryChapterSelect.addEventListener("change", renderSelectedCheckpoint);
    memorySaveBtn.addEventListener("click", saveSelectedMemory);
    memoryExportBtn.addEventListener("click", exportSelectedBook);
    memoryImportBtn.addEventListener("click", () => memoryFileInput.click());
    memoryFileInput.addEventListener("change", importBookFile);
    memoryClearBtn.addEventListener("click", clearSelectedBook);
    memoryDeleteChapterBtn.addEventListener("click", deleteSelectedCheckpoint);
    memoryClearAllBtn.addEventListener("click", clearAllMemory);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[runtime.novelMemoryCore.STORAGE_KEY]) void loadNovelMemory();
    });
  });
}
