/**
 * 应用网址（applyUrls）：绑定网址决定「术语归集到哪个库」，应用网址决定「这个库的术语在哪些页面生效」。
 * 留空 = 全站生效（与旧数据完全兼容，指纹不变）；指定后只有命中的页面会带这批术语。
 * UI 上与绑定网址同一套通配语义：行内「应用」单条、卡级「一键加入应用」全部、「清空」恢复全站。
 */
const URL_PLACEHOLDER = "支持完整网址、域名和通配符匹配。例如：*.google.com、page.kakao.com/content/69299983/*、https://comic.naver.com/webtoon/list?titleId=123456";

export function installGlossaryLibraryApplyUrls(runtime) {
  const list = document.getElementById("libraryApplyUrlList");
  const bulk = document.getElementById("libraryApplyUrlBulk");
  const textarea = document.getElementById("libraryApplyUrlsInput");
  const addBtn = document.getElementById("libraryApplyUrlAddBtn");
  const bulkBtn = document.getElementById("libraryApplyUrlBulkBtn");
  const listBtn = document.getElementById("libraryApplyUrlListBtn");
  const clearBtn = document.getElementById("libraryApplyClearBtn");
  const allBtn = document.getElementById("libraryApplyAllBtn");

  let mode = "list";

  function inputs() {
    return Array.from(list.querySelectorAll("input[data-action='edit-apply-url']"));
  }
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
  /** 当前表单里的应用网址：列表态读每一行，批量编辑态读文本框。 */
  function collect() {
    if (mode === "bulk") {
      return parseUrlLines(textarea.value);
    }
    const urls = [];
    for (const input of inputs()) {
      const url = runtime.glossaryCore.normalizeLibraryUrl(input.value);
      if (url && !urls.includes(url)) {
        urls.push(url);
      }
    }
    return urls;
  }
  runtime.collectLibraryApplyUrls = collect;
  function createRow(url, index) {
    const row = document.createElement("div");
    row.className = "url-row apply-scope";
    row.dataset.index = String(index);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "url-row-input";
    input.dataset.action = "edit-apply-url";
    input.dataset.index = String(index);
    input.value = url;
    input.placeholder = URL_PLACEHOLDER;
    input.setAttribute("aria-label", `应用网址 ${index + 1}`);
    input.addEventListener("change", () => void runtime.autoSaveLibrary());
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void runtime.autoSaveLibrary();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-url-btn";
    remove.dataset.action = "remove-apply-url";
    remove.textContent = "移除";
    remove.setAttribute("aria-label", `移除应用网址 ${index + 1}`);
    remove.addEventListener("click", () => void removeRow(row));
    row.append(input, remove);
    return row;
  }
  function createEmptyPlaceholderRow() {
    const row = document.createElement("div");
    row.className = "url-row apply-scope";
    const text = document.createElement("span");
    text.className = "url-row-placeholder";
    text.textContent = "还没有指定网址，所有网址都生效";
    row.append(text);
    return row;
  }
  function render(urls) {
    const rows = urls.map(createRow);
    if (!rows.length) {
      // 设计稿 ⑤：空名单占位行（蓝边、一行说明），不再放大段文字
      rows.push(createEmptyPlaceholderRow());
    }
    list.replaceChildren(...rows);
  }
  runtime.renderApplyUrlRows = render;
  function setMode(next) {
    const isBulk = next === "bulk";
    if (isBulk && mode !== "bulk") {
      textarea.value = collect().join("\n");
    }
    mode = isBulk ? "bulk" : "list";
    bulk.classList.toggle("hidden", !isBulk);
    list.classList.toggle("hidden", isBulk);
    bulkBtn.classList.toggle("hidden", isBulk);
    listBtn.classList.toggle("hidden", !isBulk);
    runtime.updateUrlHint?.();
  }
  runtime.setLibraryApplyUrlMode = setMode;
  async function removeRow(row) {
    const target = Number(row.dataset.index);
    const urls = [];
    inputs().forEach((input, index) => {
      const url = runtime.glossaryCore.normalizeLibraryUrl(input.value);
      if (index !== target && url && !urls.includes(url)) {
        urls.push(url);
      }
    });
    render(urls);
    runtime.renderUrlRows?.(runtime.collectLibraryUrls?.() || [], urls);
    await runtime.autoSaveLibrary();
  }
  runtime.removeApplyUrlRow = removeRow;
  function addEmptyRow() {
    const urls = collect();
    urls.push("");
    render(urls);
    const last = inputs()[urls.length - 1];
    if (last && typeof last.focus === "function") {
      last.focus();
    }
  }
  runtime.addEmptyApplyUrlRow = addEmptyRow;
  async function backToList() {
    const urls = parseUrlLines(textarea.value);
    setMode("list");
    render(urls);
    runtime.renderUrlRows?.(runtime.collectLibraryUrls?.() || [], urls);
    await runtime.autoSaveLibrary();
  }
  runtime.backToApplyUrlList = backToList;
  /** 绑定网址行上的「应用」按钮：只把这一条加进应用范围。 */
  async function applySingle(url) {
    const normalized = runtime.glossaryCore.normalizeLibraryUrl(url);
    if (!normalized) {
      return;
    }
    const urls = collect();
    if (urls.includes(normalized)) {
      return;
    }
    urls.push(normalized);
    setMode("list");
    render(urls);
    runtime.renderUrlRows?.(runtime.collectLibraryUrls?.() || [], urls);
    await runtime.autoSaveLibrary();
  }
  runtime.applySingleUrl = applySingle;
  /** 归集卡上的蓝色按钮：把全部绑定网址并入应用范围。 */
  async function applyAll() {
    const bound = runtime.collectLibraryUrls?.() || [];
    const urls = collect();
    let changed = false;
    for (const url of bound) {
      if (url && !urls.includes(url)) {
        urls.push(url);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    setMode("list");
    runtime.setLibraryUrlMode?.("list");
    render(urls);
    runtime.renderUrlRows?.(bound, urls);
    await runtime.autoSaveLibrary();
  }
  runtime.applyAllUrls = applyAll;
  /** 清空应用名单：回到「全站生效」。 */
  async function clearAll() {
    if (!collect().length) {
      return;
    }
    if (!window.confirm("清空应用网址？本库术语将恢复在所有网站生效。")) {
      return;
    }
    setMode("list");
    render([]);
    runtime.renderUrlRows?.(runtime.collectLibraryUrls?.() || [], []);
    await runtime.autoSaveLibrary();
  }
  runtime.clearApplyUrls = clearAll;
  /** 保存成功后把服务端规范化过的值写回表单（分列表态/批量态）。 */
  function syncAfterSave(urls) {
    const next = Array.isArray(urls) ? urls : [];
    if (mode === "bulk") {
      textarea.value = next.join("\n");
    } else {
      render(next);
    }
  }
  runtime.syncApplyUrlsAfterSave = syncAfterSave;
  /** 换库时整块重置：切回列表态并按该库的 applyUrls 渲染。 */
  function reset(library) {
    const urls = library ? Array.isArray(library.applyUrls) ? library.applyUrls : [] : [];
    mode = "list";
    bulk.classList.add("hidden");
    list.classList.remove("hidden");
    bulkBtn.classList.remove("hidden");
    listBtn.classList.add("hidden");
    textarea.value = urls.join("\n");
    render(urls);
  }
  runtime.resetApplyUrls = reset;
  function bindEvents() {
    addBtn.addEventListener("click", addEmptyRow);
    bulkBtn.addEventListener("click", () => setMode("bulk"));
    listBtn.addEventListener("click", () => void backToList());
    textarea.addEventListener("blur", () => void runtime.autoSaveLibrary());
    allBtn.addEventListener("click", () => void applyAll());
    clearBtn.addEventListener("click", () => void clearAll());
  }
  runtime.bindLibraryApplyUrlEvents = bindEvents;
}
