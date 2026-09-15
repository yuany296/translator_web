/**
 * 术语库页的「列表页 → 库详情页」导航（对齐沉浸式翻译：先点库名进去，再在那个库里操作）。
 *
 * 三个视图：
 *   list   —— 只回答「有哪些库」：库卡片（开关/条数/待确认数）、新建、小说记忆入口；
 *   detail —— 只回答「这个库的事」：库名 + 条数、库设置、术语表、待确认、导入/导出/清空；
 *   memory —— 小说记忆（入口暂放列表页底部，最终位置见后续决策）。
 *
 * `runtime.activeLibraryId` 仍是「当前库」的唯一真源：详情页显示哪个库、库设置填哪一份、
 * 导入去向、导出与清空的范围都由它决定；空值 = 「全部术语」总览。
 */
export function installGlossaryViewRouter(runtime) {
  const VIEW_IDS = Object.freeze({
    list: "libraryListView",
    detail: "libraryDetailView",
    memory: "memoryView"
  });
  const detailTitle = document.getElementById("detailTitle");
  const detailSubtitle = document.getElementById("detailSubtitle");
  const tableContainer = document.getElementById("tableContainer");
  const librarySettings = document.getElementById("librarySettings");
  const backToListBtn = document.getElementById("backToListBtn");
  const backFromMemoryBtn = document.getElementById("backFromMemoryBtn");
  runtime.detailTitle = detailTitle;
  runtime.detailSubtitle = detailSubtitle;
  runtime.tableContainer = tableContainer;
  runtime.librarySettings = librarySettings;
  /** 当前详情页对应的库；返回 null 表示「全部术语」总览。 */
  function currentLibrary() {
    const id = runtime.glossaryCore.normalizeLibraryId(runtime.activeLibraryId);
    return id ? runtime.glossaryCore.getLibrary(runtime.glossary, id) : null;
  }
  runtime.currentLibrary = currentLibrary;
  /**
   * 库资料卡片跟着当前库走：换了库就重新填一遍；还是同一个库时什么都不做，
   * 免得用户正在输入库名/网址时被一次无关的渲染覆盖掉。
   * 卡片是**常显**的：具体库进来就看得见，只有「全部术语」总览（没有某一个库可设置）才藏起来。
   */
  function syncLibrarySettings() {
    const library = currentLibrary();
    if (!library) {
      librarySettings.classList.add("hidden");
      librarySettings.dataset.libraryId = "";
      return;
    }
    librarySettings.classList.remove("hidden");
    if (librarySettings.dataset.libraryId === library.id) {
      return;
    }
    librarySettings.dataset.libraryId = library.id;
    runtime.prepareLibrarySettings(library);
  }
  runtime.syncLibrarySettings = syncLibrarySettings;
  function renderDetailHeader() {
    const library = currentLibrary();
    if (library) {
      const count = runtime.glossary.entries.filter(entry => entry.libraryId === library.id).length;
      detailTitle.textContent = library.name;
      // 副标题把「绑定到哪」和「参不参与翻译」都直接写出来——不用点开任何东西就能看到这个库靠什么归集新术语。
      // 启用状态只是「读出来给人看」：开关只有列表页卡片那一个，详情页不再放第二个开关。
      const state = library.enabled === false ? "已停用" : "已启用";
      detailSubtitle.textContent = library.urls.length
        ? `${count} 条术语 · ${state}（开关在术语库列表页）· 绑定 ${library.urls.length} 个网址：${library.urls[0]}`
        : `${count} 条术语 · ${state}（开关在术语库列表页）· 未绑定网址（在下面「库资料」里绑定作品总览页，章节页会自动归入）`;
      // 单库视图里「清空」只清这个库，按钮文案必须说实话。
      if (runtime.clearBtn) {
        runtime.clearBtn.textContent = "清空本库";
      }
    } else {
      detailTitle.textContent = "全部术语";
      detailSubtitle.textContent = `全部 ${runtime.glossary.libraries.length} 个术语库 · ${runtime.glossary.entries.length} 条术语`;
      if (runtime.clearBtn) {
        runtime.clearBtn.textContent = "清空全部";
      }
    }
    // 标题行里的开关已经撤掉：是否参与翻译只由列表页卡片的开关决定（避免两处开关打架）。
    syncLibrarySettings();
    // 单库视图里「术语库」列恒为同一个值，藏掉把宽度让给术语。
    tableContainer.classList.toggle("single-library", Boolean(library));
    // 删除入口放在标题行：一进库就看得到。默认术语库不能删（它接住所有没匹配到库的术语），
    // 所以对它干脆不显示按钮，理由写在库资料的说明里，避免出现「点了没反应」的死按钮。
    if (runtime.libraryDeleteBtn) {
      const deletable = Boolean(library) && library.id !== runtime.glossaryCore.DEFAULT_LIBRARY_ID;
      runtime.libraryDeleteBtn.classList.toggle("hidden", !deletable);
    }
    // 「新增术语」只在具体某个库的页面里出现：总览页不加术语（那会自动落进默认库，容易搞错）。
    runtime.addBtn?.classList.toggle("hidden", !library || runtime.activeTab === "pending");
  }
  runtime.renderDetailHeader = renderDetailHeader;
  function setView(name) {
    runtime.activeView = VIEW_IDS[name] ? name : "list";
    for (const [key, id] of Object.entries(VIEW_IDS)) {
      document.getElementById(id).classList.toggle("hidden", key !== runtime.activeView);
    }
    if (runtime.activeView === "list") {
      librarySettings.classList.add("hidden");
      runtime.renderLibraryPanel();
    }
    if (runtime.activeView === "detail") {
      renderDetailHeader();
      // 搜索框也跟着当前库走：每个库各记各的搜索词，换库绝不把上一个库的词带过来。
      runtime.syncSearchInput?.();
      // 待确认的数字与章节列表都跟着「当前是哪个库」变，换库/换视图要重算。
      runtime.renderPendingScope?.();
    }
  }
  runtime.setView = setView;

  // 数据一变（改库名/删库/条目增减）详情页标题与库卡片就跟着刷新，避免两处数字打架。
  for (const method of ["renderGlossary", "renderLibraryPanel"]) {
    const base = runtime[method];
    runtime[method] = (...args) => {
      base(...args);
      if (runtime.activeView === "detail") {
        renderDetailHeader();
      }
    };
  }
  // 点库卡片原本只过滤表格；现在它同时完成「进入这个库」的跳转。
  const focusLibrary = runtime.focusLibrary;
  runtime.focusLibrary = async libraryId => {
    // 批量选中的条目属于上一个库：换库前清掉，免得在 B 库里点「删除」删掉看不见的 A 库条目。
    runtime.clearBatchSelection?.({ rerender: false });
    await focusLibrary(libraryId);
    runtime.switchTab("official");
    setView("detail");
    // focusLibrary 内部已经重画过表格，但那时输入框还是上一个库的词：这里再同步一次。
    runtime.syncSearchInput?.();
    runtime.renderGlossary();
  };
  // 「小说记忆」是列表页底部的入口，不是详情页的标签页，所以顺带切视图。
  const switchTab = runtime.switchTab;
  runtime.switchTab = tab => {
    switchTab(tab);
    if (tab === "memory") {
      setView("memory");
      return;
    }
    if (runtime.activeView === "memory") {
      setView("detail");
      return;
    }
    // 标签切换会重设「新增术语」的显隐，这里按当前是不是具体库再收一次口。
    if (runtime.activeView === "detail") {
      renderDetailHeader();
    }
  };

  backToListBtn.addEventListener("click", () => setView("list"));
  backFromMemoryBtn.addEventListener("click", () => setView("list"));
  runtime.activeView = "list";
  if (runtime.initialView === "memory") {
    // 设置页的「小说记忆」分区：一进来就是记忆视图，不给「返回术语库」这种死路。
    runtime.switchTab("memory");
  } else {
    setView("list");
  }
}
