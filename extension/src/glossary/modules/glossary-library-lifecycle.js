/**
 * 术语库的建 / 删 / 按网址建库 / 导入入口（列表页与详情页的「库之外」的动作用它）。
 *
 * 库资料表单本身在 glossary-library-settings，这里只管「这个库从哪来、什么时候没了」。
 */
export function installGlossaryLibraryLifecycle(runtime) {
  const libraryIdInput = document.getElementById("libraryIdInput");
  const libraryDeleteBtn = document.getElementById("libraryDeleteBtn");
  const addLibraryBtn = document.getElementById("addLibraryBtn");
  const newLibraryDialog = document.getElementById("newLibraryDialog");
  const newLibraryBlankBtn = document.getElementById("newLibraryBlankBtn");
  const newLibraryImportBtn = document.getElementById("newLibraryImportBtn");
  const newLibraryCancelBtn = document.getElementById("newLibraryCancelBtn");
  const libraryTestInput = document.getElementById("libraryTestInput");
  Object.assign(runtime, { libraryDeleteBtn, addLibraryBtn });

  /** 删除当前库：库里的术语一并删除（不迁移到默认库），然后回到列表页。 */
  async function deleteCurrentLibrary() {
    const library = runtime.glossary.libraries.find(item => item.id === libraryIdInput.value);
    if (!library) {
      runtime.setStatus("没找到这个术语库（可能已经被删掉了），返回列表刷新一下", true);
      return;
    }
    if (library.id === runtime.glossaryCore.DEFAULT_LIBRARY_ID) {
      runtime.setStatus("默认术语库不能删除：没匹配到任何库的术语都归它", true);
      return;
    }
    const count = runtime.glossary.entries.filter(entry => entry.libraryId === library.id).length;
    // 删库 = 删条目（用户本意）。想留住术语就明说要先搬走，别让人以为删库还能捞回来。
    const confirmed = window.confirm(count
      ? `删除术语库「${library.name}」？\n其中 ${count} 条术语会一起删除，无法恢复。\n（想保留术语请先取消，到库里用「移动到…」搬到别的库。）`
      : `删除术语库「${library.name}」？`);
    if (!confirmed) {
      runtime.setStatus(`没有删除「${library.name}」（你取消了确认）`, false);
      return;
    }
    const result = await runtime.removeLibrary(library.id);
    if (result.ok === false) {
      runtime.setStatus(result.error, true);
      return;
    }
    const message = `已删除「${library.name}」${result.removed ? `，连同 ${result.removed} 条术语一起删除` : ""}`;
    // 删完会回到列表页，所以两个状态行都写：详情页那条用于万一没跳转，列表页那条是你回去后看到的。
    runtime.setStatus(message, false);
    runtime.setLibraryStatus(message, false);
    runtime.setView?.("list");
  }
  runtime.deleteCurrentLibrary = deleteCurrentLibrary;
  /** 删除按钮的可用性跟着当前库走：默认术语库不能删（它接住所有没匹配到库的术语）。 */
  function updateLibraryDeleteButton(library) {
    const deletable = Boolean(library) && library.id !== runtime.glossaryCore.DEFAULT_LIBRARY_ID;
    libraryDeleteBtn.disabled = !deletable;
    libraryDeleteBtn.title = deletable
      ? "删除这个库，库里的术语会一起删除（想保留请先用「移动到…」搬到别的库）"
      : "默认术语库不能删除：没匹配到任何库的术语都归它";
  }
  runtime.updateLibraryDeleteButton = updateLibraryDeleteButton;
  /** 新建术语库：先建一个安静的名字并进入这个库，改名就在库资料里直接做。 */
  function nextLibraryName() {
    const used = new Set(runtime.glossary.libraries.map(library => library.name.toLocaleLowerCase()));
    if (!used.has("新术语库")) {
      return "新术语库";
    }
    for (let index = 2; index < 100; index += 1) {
      if (!used.has(`新术语库 ${index}`)) {
        return `新术语库 ${index}`;
      }
    }
    return `新术语库 ${Date.now()}`;
  }
  runtime.nextLibraryName = nextLibraryName;
  async function createLibraryAndOpen() {
    const result = await runtime.saveLibrary({ name: nextLibraryName(), enabled: true, urls: [] });
    if (result.ok === false) {
      runtime.setLibraryStatus(result.error, true);
      return;
    }
    await runtime.focusLibrary(result.library.id);
    runtime.openLibrarySettings(result.library);
  }
  runtime.createLibraryAndOpen = createLibraryAndOpen;

  /**
   * 总览页的「导入文件」：先清掉当前选中的库，让去向按文件名走（在库里导入才会全进那个库），
   * 然后直接开系统文件框——选完文件立刻落库，不再有第二个弹窗。
   */
  function startLibraryImport() {
    runtime.activeLibraryId = "";
    runtime.setLibraryStatus("选好文件就直接落库：CSV 按文件名建库，JSON 按文件里自带的库归属", false);
    runtime.fileInput.click();
  }
  runtime.startLibraryImport = startLibraryImport;

  /** 「新建术语库」先问一句：建空库，还是从文件建库（沉浸式翻译那种两条路）。 */
  function openNewLibraryDialog() {
    if (typeof newLibraryDialog.showModal === "function") {
      newLibraryDialog.showModal();
      return;
    }
    createLibraryAndOpen();
  }
  runtime.openNewLibraryDialog = openNewLibraryDialog;
  /** 从章节网址推一个库名建议：去掉最后两段路径（通常是 viewer/<章节号>）。 */
  function libraryNameFromUrl(url) {
    const normalized = runtime.glossaryCore.normalizeLibraryUrl(url);
    if (!normalized) {
      return "";
    }
    const parts = normalized.replace(/^https?:\/\//u, "").split("/");
    const trimmed = parts.slice(0, Math.max(1, parts.length - 2)).join("/");
    return trimmed || normalized;
  }
  runtime.libraryNameFromUrl = libraryNameFromUrl;
  /** 待确认章节里的「为这个网址新建库」：按网址推名字、绑上该网址，然后进这个库。 */
  async function openLibraryForUrl(pageUrl, suggestedName = "") {
    const name = String(suggestedName || "").trim() || libraryNameFromUrl(pageUrl);
    const url = runtime.glossaryCore.normalizeLibraryUrl(pageUrl);
    const result = await runtime.saveLibrary({ name, enabled: true, urls: url ? [url] : [] });
    if (result.ok === false) {
      runtime.setLibraryStatus(result.error, true);
      return;
    }
    await runtime.focusLibrary(result.library.id);
    runtime.openLibrarySettings(result.library);
    libraryTestInput.value = String(pageUrl || "");
    runtime.updateLibraryTest?.();
  }
  runtime.openLibraryForUrl = openLibraryForUrl;

  function bindLibraryLifecycleEvents() {
    addLibraryBtn.addEventListener("click", openNewLibraryDialog);
    newLibraryBlankBtn.addEventListener("click", () => {
      newLibraryDialog.close();
      void createLibraryAndOpen();
    });
    newLibraryImportBtn.addEventListener("click", () => {
      newLibraryDialog.close();
      startLibraryImport();
    });
    newLibraryCancelBtn.addEventListener("click", () => newLibraryDialog.close());
    libraryDeleteBtn.addEventListener("click", () => void deleteCurrentLibrary());
  }
  runtime.bindLibraryLifecycleEvents = bindLibraryLifecycleEvents;
}
