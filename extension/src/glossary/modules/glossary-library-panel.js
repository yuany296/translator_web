/**
 * 术语库列表页：一行一个库的卡片（开关 / 库名 / 条数 / 待确认数）+ 待确认章节的目标库控件。
 * 「编辑一个库」的表单不在这里，见 glossary-library-settings.js。
 */
export function installGlossaryLibraryPanel(runtime) {
  const ALL_LIBRARIES = "";
  function libraryCounts() {
    const counts = new Map();
    for (const entry of runtime.glossary.entries) {
      counts.set(entry.libraryId, (counts.get(entry.libraryId) || 0) + 1);
    }
    return counts;
  }
  function renderLibraryPanel() {
    if (!runtime.libraryList) {
      return;
    }
    const counts = libraryCounts();
    const pendingCounts = pendingCountsByLibrary();
    const rows = [createLibraryRow({
      id: ALL_LIBRARIES, name: "全部术语", enabled: true, urls: []
    }, runtime.glossary.entries.length, true, [...pendingCounts.values()].reduce((total, value) => total + value, 0))];
    for (const library of runtime.glossary.libraries) {
      rows.push(createLibraryRow(library, counts.get(library.id) || 0, false, pendingCounts.get(library.id) || 0));
    }
    runtime.libraryList.replaceChildren(...rows);
    runtime.libraryTotalText.textContent = `${runtime.glossary.libraries.length} 个术语库 · ${runtime.glossary.entries.length} 条术语`;
  }
  runtime.renderLibraryPanel = renderLibraryPanel;
  /**
   * 每个库名下有多少条待确认术语：候选取向跟术语库走（手动指定 → 网址绑定匹配 → 默认库），
   * 列表页得把这个数字显示出来，否则进了库才看得到候选。
   */
  function pendingCountsByLibrary() {
    const counts = new Map();
    for (const chapter of runtime.pendingStore?.chapters || []) {
      if (!chapter.candidates.length) {
        continue;
      }
      const libraryId = runtime.effectiveLibraryId(chapter);
      counts.set(libraryId, (counts.get(libraryId) || 0) + chapter.candidates.length);
    }
    return counts;
  }
  runtime.pendingCountsByLibrary = pendingCountsByLibrary;
  function createLibraryRow(library, count, isAll, pendingCount = 0) {
    const row = document.createElement("div");
    row.className = "library-row";
    row.dataset.libraryId = library.id;
    row.dataset.active = String(runtime.activeLibraryId === library.id);
    const swatch = document.createElement("input");
    swatch.type = "checkbox";
    swatch.className = "library-switch";
    swatch.role = "switch";
    swatch.dataset.action = "toggle-library";
    swatch.checked = library.enabled !== false;
    swatch.disabled = isAll;
    swatch.title = isAll ? "全部术语不是术语库" : (library.enabled === false ? "已停用：该库术语不参与翻译" : "已启用：该库术语参与翻译");
    swatch.setAttribute("aria-label", `启用术语库 ${library.name}`);
    const body = document.createElement("div");
    body.className = "library-body";
    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "library-name";
    nameButton.dataset.action = "focus-library";
    nameButton.textContent = library.name;
    nameButton.title = isAll ? "显示全部术语" : "点进去管理这个术语库";
    // 设计稿：条数在库名下方（卡片主体两行），待确认胶囊才在行尾
    const countText = document.createElement("span");
    countText.className = "library-count";
    countText.textContent = `${count} 条术语`;
    body.append(nameButton, countText);
    row.append(swatch, body);
    if (pendingCount > 0) {
      const pending = document.createElement("span");
      pending.className = "library-pending";
      pending.textContent = `${pendingCount} 条待确认`;
      row.append(pending);
    }
    return row;
  }
  runtime.createLibraryRow = createLibraryRow;
  function fillLibraryOptions(select, selectedId) {
    return runtime.fillLibraryOptions(select, selectedId);
  }
  /** 章节最终会用的库：手动指定优先，其次按网址自动匹配，最后是默认库。 */
  function effectiveLibraryId(chapter) {
    if (chapter.libraryId) {
      return chapter.libraryId;
    }
    const matched = runtime.glossaryCore.matchLibraryByUrl(runtime.glossary.libraries, chapter.url);
    return matched ? matched.libraryId : runtime.glossaryCore.DEFAULT_LIBRARY_ID;
  }
  runtime.effectiveLibraryId = effectiveLibraryId;
  function chapterLibraryHint(chapter) {
    const matched = runtime.glossaryCore.matchLibraryByUrl(runtime.glossary.libraries, chapter.url);
    const label = runtime.libraryLabel(effectiveLibraryId(chapter)) || runtime.glossaryCore.DEFAULT_LIBRARY_NAME;
    if (chapter.libraryManual) {
      return `候选将加入（已手动指定）：${label}`;
    }
    return matched ? `候选将加入（网址匹配 ${matched.pattern}）：${label}` : `候选将加入（网址未匹配绑定）：${label}`;
  }
  runtime.chapterLibraryHint = chapterLibraryHint;
  /** 章节下拉框：多一个"自动（按网址匹配）"选项（值为空串，表示不手动指定）。 */
  function fillChapterLibraryOptions(select, chapter) {
    fillLibraryOptions(select, effectiveLibraryId(chapter));
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "自动（按网址匹配）";
    select.prepend(auto);
  }
  runtime.fillChapterLibraryOptions = fillChapterLibraryOptions;
  /** 章节标题下方的一行控件：目标术语库选择 + 一键按网址建库。 */
  function buildChapterLibraryControl(chapter) {
    const wrap = document.createElement("div");
    wrap.className = "chapter-library";
    wrap.dataset.chapterKey = chapter.key;
    const hint = document.createElement("span");
    hint.className = "chapter-library-hint";
    hint.textContent = chapterLibraryHint(chapter);
    const select = document.createElement("select");
    select.className = "chapter-library-select";
    select.dataset.chapterKey = chapter.key;
    select.setAttribute("aria-label", "这条网址上的新术语放入哪个术语库");
    fillChapterLibraryOptions(select, chapter);
    const create = document.createElement("button");
    create.type = "button";
    create.dataset.action = "new-library";
    create.dataset.chapterKey = chapter.key;
    create.dataset.chapterUrl = chapter.url;
    create.textContent = "为这个网址新建库";
    wrap.append(hint, select, create);
    return wrap;
  }
  runtime.buildChapterLibraryControl = buildChapterLibraryControl;
  /** 术语库变化后刷新已有章节控件（选择项与提示文案）。 */
  function refreshPendingLibraryControls() {
    if (!runtime.pendingChapters) {
      return;
    }
    for (const wrap of runtime.pendingChapters.querySelectorAll(".chapter-library")) {
      const chapterKey = wrap.dataset.chapterKey;
      const chapter = runtime.pendingStore.chapters.find(item => item.key === chapterKey);
      if (!chapter) {
        continue;
      }
      fillChapterLibraryOptions(wrap.querySelector(".chapter-library-select"), chapter);
      wrap.querySelector(".chapter-library-hint").textContent = chapterLibraryHint(chapter);
    }
  }
  runtime.refreshPendingLibraryControls = refreshPendingLibraryControls;
  async function handleLibraryListClick(event) {
    const row = event.target.closest(".library-row");
    if (!row) {
      return;
    }
    // 列表行只有一个动作：进入这个库（开关除外，它只切换启用状态）。
    if (event.target.tagName === "INPUT") {
      return;
    }
    await runtime.focusLibrary(row.dataset.libraryId);
  }
  runtime.handleLibraryListClick = handleLibraryListClick;
  async function handleLibraryToggle(event) {
    if (event.target.dataset.action !== "toggle-library") {
      return;
    }
    const row = event.target.closest(".library-row");
    if (!row || row.dataset.libraryId === ALL_LIBRARIES) {
      return;
    }
    const result = await runtime.setLibraryEnabled(row.dataset.libraryId, event.target.checked);
    if (result.ok === false) {
      runtime.setLibraryStatus(result.error, true);
      runtime.renderLibraryPanel();
    }
  }
  runtime.handleLibraryToggle = handleLibraryToggle;
  async function handlePendingLibraryChange(event) {
    const select = event.target.closest(".chapter-library-select");
    if (!select) {
      return;
    }
    const chapterKey = select.dataset.chapterKey;
    const chosen = select.value;
    try {
      await runtime.assignChapterLibrary(chapterKey, chosen);
      const chapter = runtime.pendingStore.chapters.find(item => item.key === chapterKey);
      if (chapter) {
        chapter.libraryId = runtime.glossaryCore.normalizeLibraryId(chosen);
        chapter.libraryManual = Boolean(chapter.libraryId);
      }
      // 刷新会把下拉框恢复到"最终生效的库"，所以提示文案用用户刚才选的值。
      runtime.refreshPendingLibraryControls();
      runtime.setPendingStatus(chosen
        ? `该章节的新术语将加入「${runtime.libraryLabel(chosen)}」`
        : "该章节已改回按网址自动匹配术语库", false);
    } catch (error) {
      runtime.setPendingStatus(`设置失败：${runtime.getErrorMessage(error)}`, true);
    }
  }
  runtime.handlePendingLibraryChange = handlePendingLibraryChange;
  async function handlePendingLibraryClick(event) {
    const button = event.target.closest("button[data-action='new-library']");
    if (!button) {
      return;
    }
    event.preventDefault();
    runtime.openLibraryForUrl(button.dataset.chapterUrl);
  }
  runtime.handlePendingLibraryClick = handlePendingLibraryClick;
  function bindLibraryPanelEvents() {
    runtime.libraryList.addEventListener("click", runtime.handleLibraryListClick);
    runtime.libraryList.addEventListener("change", runtime.handleLibraryToggle);
    runtime.pendingChapters.addEventListener("change", runtime.handlePendingLibraryChange);
    runtime.pendingChapters.addEventListener("click", runtime.handlePendingLibraryClick);
    runtime.bindLibrarySettingsEvents();
  }
  runtime.bindLibraryPanelEvents = bindLibraryPanelEvents;
  const libraryList = document.getElementById("libraryList");
  runtime.libraryList = libraryList;
  const libraryTotalText = document.getElementById("libraryTotalText");
  runtime.libraryTotalText = libraryTotalText;
  const libraryStatusText = document.getElementById("libraryStatusText");
  runtime.libraryStatusText = libraryStatusText;
  runtime.libraryServerSupported = true;
}
