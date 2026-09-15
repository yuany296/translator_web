/**
 * 网址归属测试：粘一个章节网址，看这条网址上察觉到的新术语会不会归入本库。
 *
 * 界面上只是绑定网址下面一个「网址归属测试…」按钮，点开是弹窗——按用户的规矩，
 * 能在弹窗里做的事就不往页面上再塞一段常显表单。
 */
export function installGlossaryLibraryTest(runtime) {
  const libraryTestBtn = document.getElementById("libraryTestBtn");
  const libraryTestDialog = document.getElementById("libraryTestDialog");
  const libraryTestInput = document.getElementById("libraryTestInput");
  const libraryTestResult = document.getElementById("libraryTestResult");
  const libraryShortenBtn = document.getElementById("libraryShortenBtn");
  const libraryAddTestUrlBtn = document.getElementById("libraryAddTestUrlBtn");
  const libraryTestCloseBtn = document.getElementById("libraryTestCloseBtn");
  Object.assign(runtime, {
    libraryTestBtn, libraryTestDialog, libraryTestInput, libraryTestResult,
    libraryShortenBtn, libraryAddTestUrlBtn, libraryTestCloseBtn
  });

  function openLibraryTest() {
    updateLibraryTest();
    if (typeof libraryTestDialog.showModal === "function") {
      libraryTestDialog.showModal();
    } else {
      libraryTestDialog.open = true;
    }
    if (typeof libraryTestInput.focus === "function") {
      libraryTestInput.focus();
    }
  }
  runtime.openLibraryTest = openLibraryTest;
  /** 换库时把上一次粘的网址和结论一起清掉，免得看着像测的还是新库。 */
  function resetLibraryTest() {
    libraryTestInput.value = "";
    updateLibraryTest();
  }
  runtime.resetLibraryTest = resetLibraryTest;
  function updateLibraryTest() {
    const urls = runtime.collectLibraryUrls ? runtime.collectLibraryUrls() : [];
    const pageUrl = String(libraryTestInput.value || "").trim();
    if (!pageUrl) {
      libraryTestResult.textContent = urls.length
        ? `本库已绑定 ${urls.length} 个网址；粘一个章节网址就能试出它归不归本库。`
        : "本库还没绑定任何网址：任何页面察觉到的新术语都不会归进来。";
      libraryTestResult.dataset.match = urls.length ? "idle" : "warn";
      return;
    }
    const normalizedPage = runtime.glossaryCore.normalizeLibraryUrl(pageUrl);
    const hit = urls.find(url => runtime.glossaryCore.libraryUrlMatches(pageUrl, url));
    if (hit) {
      libraryTestResult.textContent = `✓ 会命中：这条网址会归入本库（匹配 ${hit}）${urls.length > 1 ? `，本库共 ${urls.length} 个绑定` : ""}`;
      libraryTestResult.dataset.match = "hit";
      return;
    }
    libraryTestResult.textContent = `✗ 不命中：${normalizedPage || pageUrl} 不属于当前绑定的任何网址（可点“缩短一级目录”）`;
    libraryTestResult.dataset.match = "miss";
  }
  runtime.updateLibraryTest = updateLibraryTest;
  function shortenTestUrl() {
    const current = runtime.glossaryCore.normalizeLibraryUrl(libraryTestInput.value);
    if (!current) {
      return;
    }
    const cut = current.lastIndexOf("/");
    const origin = `${current.split("/")[0]}//${current.split("/")[2]}`;
    libraryTestInput.value = cut > origin.length ? current.slice(0, cut) : current;
    updateLibraryTest();
  }
  runtime.shortenTestUrl = shortenTestUrl;
  /** 弹窗里的「把这条加进绑定」：规范化后追加，列表里已经有了就不重复加。 */
  async function addTestUrlToLibrary() {
    const url = runtime.glossaryCore.normalizeLibraryUrl(libraryTestInput.value);
    if (!url) {
      runtime.setLibraryStatus("这行不像一个网址，先粘一个章节页地址", true);
      return;
    }
    const urls = runtime.collectLibraryUrls();
    if (!urls.includes(url)) {
      urls.push(url);
      runtime.setLibraryUrlMode("list");
      runtime.renderUrlRows(urls);
      await runtime.autoSaveLibrary();
      const library = runtime.currentLibrary ? runtime.currentLibrary() : null;
      runtime.setLibraryStatus(`已把 ${url} 加进「${library ? library.name : ""}」的绑定`, false);
    }
    updateLibraryTest();
  }
  runtime.addTestUrlToLibrary = addTestUrlToLibrary;

  function bindLibraryTestEvents() {
    libraryTestBtn.addEventListener("click", openLibraryTest);
    libraryTestInput.addEventListener("input", updateLibraryTest);
    libraryShortenBtn.addEventListener("click", shortenTestUrl);
    libraryAddTestUrlBtn.addEventListener("click", () => void addTestUrlToLibrary());
    libraryTestCloseBtn.addEventListener("click", () => libraryTestDialog.close());
  }
  runtime.bindLibraryTestEvents = bindLibraryTestEvents;
}
