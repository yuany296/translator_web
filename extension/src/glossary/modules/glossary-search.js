/**
 * 术语库搜索框的状态：**按库各记各的**。
 *
 * 键就是当前库的 id（空串 = 「全部术语」总览）。一个框被所有库共用的老做法会让
 * 「在 A 库搜的词」跟着进 B 库，B 库看着像空的——换库时把框换成那个库自己那一份，谁都不串。
 */
export function installGlossarySearch(runtime) {
  const searchInput = document.getElementById("searchInput");
  runtime.searchInput = searchInput;
  const searchQueries = new Map();
  runtime.searchQueries = searchQueries;

  function searchKey() {
    return runtime.glossaryCore.normalizeLibraryId(runtime.activeLibraryId) || "";
  }
  runtime.searchKey = searchKey;
  function currentSearchQuery() {
    return searchQueries.get(searchKey()) || "";
  }
  runtime.currentSearchQuery = currentSearchQuery;
  function setSearchQuery(value) {
    const text = String(value || "");
    if (text.trim()) {
      searchQueries.set(searchKey(), text);
    } else {
      searchQueries.delete(searchKey());
    }
    return text;
  }
  runtime.setSearchQuery = setSearchQuery;
  /** 打字：先记进当前库那一份，再重画表格。 */
  function handleSearchInput() {
    setSearchQuery(searchInput.value);
    runtime.renderGlossary();
  }
  runtime.handleSearchInput = handleSearchInput;
  /** 换库 / 换视图：把输入框与提示换成当前库自己那一份（只在真的不同时才写 value，免得打字时插入符乱跳）。 */
  function syncSearchInput() {
    const query = currentSearchQuery();
    if (searchInput.value !== query) {
      searchInput.value = query;
    }
    const libraryName = runtime.activeLibraryId
      ? runtime.glossaryCore.getLibraryName(runtime.glossary, runtime.activeLibraryId) : "";
    searchInput.placeholder = libraryName
      ? `在「${libraryName}」中搜索原文、译文或备注`
      : "在全部术语中搜索原文、译文或备注";
  }
  runtime.syncSearchInput = syncSearchInput;
}
