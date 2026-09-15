/**
 * 库设置（改名 / 绑定网址 / 重复清理）。
 *
 * 这一块就长在「这个库的页面」里（`#librarySettings`），**常显**：进库就能改，没有「编辑资料」那一步，
 * 也没有「保存 / 收起」——改完离开格子（或按回车）就自动存，右上角闪一下「已保存 ✓」。
 * 是否参与翻译**不在这里**：只由列表页卡片的开关决定，免得两处开关打架（见 glossary-library-panel）。
 * 网址归属测试是独立弹窗，见 glossary-library-test；建库/删库见 glossary-library-lifecycle。
 */
/** 空行的提示示例：换着给几个站，用户一眼看出「粘什么、还能写通配」。 */
const URL_EXAMPLES = [
  "https://page.kakao.com/content/69299983/",
  "https://comic.naver.com/webtoon/list?titleId=123456",
  "https://www.pixiv.net/artworks/12345678",
  "*.google.com"
];

export function installGlossaryLibrarySettings(runtime) {
  const librarySettings = document.getElementById("librarySettings");
  const libraryForm = document.getElementById("libraryForm");
  const libraryIdInput = document.getElementById("libraryIdInput");
  const libraryNameInput = document.getElementById("libraryNameInput");
  const libraryNameError = document.getElementById("libraryNameError");
  const librarySavedHint = document.getElementById("librarySavedHint");
  const libraryUrlList = document.getElementById("libraryUrlList");
  const libraryUrlBulk = document.getElementById("libraryUrlBulk");
  const libraryUrlsInput = document.getElementById("libraryUrlsInput");
  const libraryUrlAddBtn = document.getElementById("libraryUrlAddBtn");
  const libraryUrlBulkBtn = document.getElementById("libraryUrlBulkBtn");
  const libraryUrlListBtn = document.getElementById("libraryUrlListBtn");
  const libraryUrlHint = document.getElementById("libraryUrlHint");
  const libraryDedupeBtn = document.getElementById("libraryDedupeBtn");
  const libraryDedupeHint = document.getElementById("libraryDedupeHint");
  Object.assign(runtime, {
    librarySettings, libraryForm, libraryIdInput, libraryNameInput, libraryNameError,
    librarySavedHint, libraryUrlList, libraryUrlsInput, libraryUrlHint,
    libraryDedupeBtn
  });

  let urlMode = "list";
  let savedSnapshot = "";
  let savedTimer = null;

  function parseUrlLines(text) {
    const urls = [];
    for (const line of String(text || "").split(/\r?\n/u)) {
      const url = runtime.glossaryCore.normalizeLibraryUrl(line);
      if (url && !urls.includes(url)) {
        urls.push(url);
      }
    }
    return urls;
  }
  runtime.parseUrlLines = parseUrlLines;
  function urlInputs() {
    return Array.from(libraryUrlList.querySelectorAll("input[data-action='edit-url']"));
  }
  /** 当前表单里的绑定网址：列表态读每一行，批量编辑态读文本框。 */
  function collectUrls() {
    if (urlMode === "bulk") {
      return parseUrlLines(libraryUrlsInput.value);
    }
    const urls = [];
    for (const input of urlInputs()) {
      const url = runtime.glossaryCore.normalizeLibraryUrl(input.value);
      if (url && !urls.includes(url)) {
        urls.push(url);
      }
    }
    return urls;
  }
  runtime.collectLibraryUrls = collectUrls;
  function updateUrlHint() {
    const count = collectUrls().length;
    libraryUrlHint.textContent = count
      ? `已绑定 ${count} 个网址：保存时去掉查询串、片段与末尾斜杠；这些网址的章节页会自动归入本库。`
      : "还没绑定网址：该库不会自动接收任何页面察觉到的术语。";
  }
  runtime.updateUrlHint = updateUrlHint;
  function createUrlRow(url, index) {
    const row = document.createElement("div");
    row.className = "url-row";
    row.dataset.index = String(index);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "url-row-input";
    input.dataset.action = "edit-url";
    input.dataset.index = String(index);
    input.value = url;
    input.placeholder = URL_EXAMPLES[index % URL_EXAMPLES.length];
    input.setAttribute("aria-label", `绑定网址 ${index + 1}`);
    input.addEventListener("change", () => void autoSaveLibrary());
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void autoSaveLibrary();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.action = "remove-url";
    remove.textContent = "删除";
    remove.setAttribute("aria-label", `删除绑定网址 ${index + 1}`);
    remove.addEventListener("click", () => void removeUrlRow(row));
    row.append(input, remove);
    return row;
  }
  function renderUrlRows(urls) {
    const rows = urls.map(createUrlRow);
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "library-hint";
      empty.textContent = "还没有绑定网址，点下面「＋ 添加网址」或「批量编辑」粘一整列（例如 page.kakao.com 的作品总览页，或 *.google.com 这样的通配）。";
      rows.push(empty);
    }
    libraryUrlList.replaceChildren(...rows);
  }
  runtime.renderUrlRows = renderUrlRows;
  function setUrlMode(mode) {
    const bulk = mode === "bulk";
    if (bulk && urlMode !== "bulk") {
      libraryUrlsInput.value = collectUrls().join("\n");
    }
    urlMode = bulk ? "bulk" : "list";
    libraryUrlBulk.classList.toggle("hidden", !bulk);
    libraryUrlList.classList.toggle("hidden", bulk);
    libraryUrlBulkBtn.classList.toggle("hidden", bulk);
    libraryUrlListBtn.classList.toggle("hidden", !bulk);
    updateUrlHint();
  }
  runtime.setLibraryUrlMode = setUrlMode;
  async function removeUrlRow(row) {
    const target = Number(row.dataset.index);
    const urls = [];
    urlInputs().forEach((input, index) => {
      const url = runtime.glossaryCore.normalizeLibraryUrl(input.value);
      if (index !== target && url && !urls.includes(url)) {
        urls.push(url);
      }
    });
    renderUrlRows(urls);
    await autoSaveLibrary();
  }
  runtime.removeUrlRow = removeUrlRow;
  function addEmptyUrlRow() {
    const urls = collectUrls();
    urls.push("");
    renderUrlRows(urls);
    const inputs = urlInputs();
    const last = inputs[inputs.length - 1];
    if (last && typeof last.focus === "function") {
      last.focus();
    }
  }
  runtime.addEmptyUrlRow = addEmptyUrlRow;
  async function backToUrlList() {
    const urls = parseUrlLines(libraryUrlsInput.value);
    setUrlMode("list");
    renderUrlRows(urls);
    await autoSaveLibrary();
  }
  runtime.backToUrlList = backToUrlList;

  function showNameError(message) {
    libraryNameError.textContent = String(message || "");
    libraryNameError.classList.toggle("hidden", !message);
  }
  runtime.showLibraryNameError = showNameError;
  function flashSaved() {
    librarySavedHint.classList.add("on");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => librarySavedHint.classList.remove("on"), 1600);
  }
  runtime.flashLibrarySaved = flashSaved;
  function snapshotOf(name, urls) {
    return JSON.stringify({ name, urls });
  }
  /**
   * 自动保存：名称 / 绑定网址改完离开格子就存。
   * 注意 `saveLibrary` 里 `enabled` 的默认值是 true —— 开关已经不在这一页了，必须原样带上当前库的
   * enabled，否则「停用的库」被随便改个名字就会被静默改成启用。
   */
  async function autoSaveLibrary() {
    const library = runtime.currentLibrary ? runtime.currentLibrary() : null;
    if (!library) {
      return { ok: false, error: "当前不在某个术语库里" };
    }
    const name = String(libraryNameInput.value || "").trim();
    if (!name) {
      showNameError("术语库名称不能为空");
      libraryNameInput.value = library.name;
      return { ok: false, error: "术语库名称不能为空" };
    }
    const urls = collectUrls();
    if (snapshotOf(name, urls) === savedSnapshot) {
      showNameError("");
      updateUrlHint();
      return { ok: true, unchanged: true };
    }
    const result = await runtime.saveLibrary({
      id: library.id,
      name,
      enabled: library.enabled !== false,
      urls
    });
    if (result.ok === false) {
      showNameError(result.error);
      return result;
    }
    showNameError("");
    const saved = result.library || library;
    savedSnapshot = snapshotOf(saved.name, saved.urls);
    libraryNameInput.value = saved.name;
    if (urlMode === "bulk") {
      libraryUrlsInput.value = saved.urls.join("\n");
    } else {
      renderUrlRows(saved.urls);
    }
    updateUrlHint();
    flashSaved();
    return result;
  }
  runtime.autoSaveLibrary = autoSaveLibrary;

  /** 把某个库的值填进「库资料」卡片（常显，不需要展开）。 */
  function prepareLibrarySettings(library = null) {
    libraryIdInput.value = library ? library.id : "";
    libraryNameInput.value = library ? library.name : "";
    libraryUrlsInput.value = library ? library.urls.join("\n") : "";
    urlMode = "list";
    libraryUrlBulk.classList.add("hidden");
    libraryUrlList.classList.remove("hidden");
    libraryUrlBulkBtn.classList.remove("hidden");
    libraryUrlListBtn.classList.add("hidden");
    renderUrlRows(library ? library.urls : []);
    showNameError("");
    savedSnapshot = library ? snapshotOf(library.name, library.urls) : "";
    runtime.updateLibraryDeleteButton?.(library);
    renderDedupeControl(library);
    updateUrlHint();
    runtime.resetLibraryTest?.();
    return library;
  }
  runtime.prepareLibrarySettings = prepareLibrarySettings;
  /** 兼容旧调用（新建库 / 按网址建库之后）：只负责把值填好，不再有展开/收起。 */
  function openLibrarySettings(library = null) {
    return prepareLibrarySettings(library);
  }
  runtime.openLibrarySettings = openLibrarySettings;

  /**
   * 「清理其它库已有的」只在默认术语库里出现：先把总表导成 CSV、让 AI 按书拆开再导进各自的库之后，
   * 默认库里通常还剩着同一批术语，这个按钮一次清掉（判定口径见 glossary-library-store）。
   */
  function renderDedupeControl(library) {
    const isDefault = Boolean(library && library.id === runtime.glossaryCore.DEFAULT_LIBRARY_ID);
    const duplicates = isDefault && runtime.duplicateEntriesInDefaultLibrary
      ? runtime.duplicateEntriesInDefaultLibrary() : [];
    libraryDedupeBtn.classList.toggle("hidden", !isDefault);
    libraryDedupeBtn.disabled = duplicates.length === 0;
    libraryDedupeBtn.textContent = duplicates.length
      ? `清理其它库已有的（${duplicates.length} 条）` : "清理其它库已有的";
    libraryDedupeHint.textContent = !isDefault
      ? ""
      : `默认术语库不能删除（没匹配到任何库的术语都归它）。${duplicates.length
        ? `里面有 ${duplicates.length} 条术语在别的库已经存在：点上面的按钮只删默认库里的这些，其它库不受影响。`
        : "里面没有与其它库重复的术语。"}`;
  }
  runtime.renderDedupeControl = renderDedupeControl;

  async function removeDefaultDuplicates() {
    const duplicates = runtime.duplicateEntriesInDefaultLibrary
      ? runtime.duplicateEntriesInDefaultLibrary() : [];
    if (!duplicates.length) {
      runtime.setLibraryStatus("默认术语库里没有与其它库重复的术语", false);
      return;
    }
    if (!window.confirm(`从默认术语库删除 ${duplicates.length} 条「其它库已有」的术语？其它库里的同名术语不受影响。`)) {
      return;
    }
    const result = await runtime.removeDuplicateEntriesFromDefaultLibrary();
    runtime.setLibraryStatus(
      result && result.removed
        ? `已从默认术语库删除 ${result.removed} 条与其它库重复的术语`
        : "没有需要删除的重复术语",
      false
    );
    renderDedupeControl(runtime.currentLibrary ? runtime.currentLibrary() : null);
  }
  runtime.removeDefaultDuplicates = removeDefaultDuplicates;

  function saveLibraryForm(event) {
    event.preventDefault();
    void autoSaveLibrary();
  }
  runtime.saveLibraryForm = saveLibraryForm;

  function bindLibrarySettingsEvents() {
    libraryForm.addEventListener("submit", saveLibraryForm);
    libraryNameInput.addEventListener("blur", () => void autoSaveLibrary());
    libraryNameInput.addEventListener("keydown", event => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void autoSaveLibrary();
    });
    libraryUrlAddBtn.addEventListener("click", addEmptyUrlRow);
    libraryUrlBulkBtn.addEventListener("click", () => setUrlMode("bulk"));
    libraryUrlListBtn.addEventListener("click", () => void backToUrlList());
    libraryUrlsInput.addEventListener("blur", () => void autoSaveLibrary());
    libraryDedupeBtn.addEventListener("click", () => void removeDefaultDuplicates());
    runtime.bindLibraryTestEvents?.();
    runtime.bindLibraryLifecycleEvents?.();
  }
  runtime.bindLibrarySettingsEvents = bindLibrarySettingsEvents;
}
