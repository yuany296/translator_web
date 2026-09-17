const NOVEL_SHADOW_STYLES = [
  "[data-p-id] .mt-novel-source[hidden],",
  "[data-p-id] .mt-novel-translation[hidden] { display: none !important; }",
  "[data-p-id] .mt-novel-source { display: contents; }",
  "[data-p-id] .mt-novel-translation { white-space: pre-wrap; font: inherit; color: inherit; }",
  "[data-p-id] .mt-novel-source-bilingual { display: block; margin-bottom: 0.42em; }",
  "[data-p-id]::selection,",
  "[data-p-id] .mt-novel-source::selection,",
  "[data-p-id] .mt-novel-translation::selection { background: rgba(96, 165, 250, 0.4); color: inherit; }"
].join("\n");

export function installNovelRenderer(runtime) {
  function injectNovelStyles(root) {
    // 小说正文在 shadow root 内,content script 的 styles.css 无法穿透,
    // 需要把等价规则注入到每个 shadow root(幂等)。
    if (!root || root === document || root.nodeType !== 11 || root.__mtNovelStylesInjected) return;
    root.__mtNovelStylesInjected = true;
    try {
      const style = document.createElement("style");
      style.className = "mt-novel-styles";
      style.textContent = NOVEL_SHADOW_STYLES;
      root.appendChild(style);
    } catch {
      root.__mtNovelStylesInjected = false;
    }
  }
  runtime.injectNovelStyles = injectNovelStyles;

  /**
   * 解析段落 id。形如 "52#3@ab12cd34ef56":
   *   pid=52(原始 data-p-id)、ordinal=3(同 id 节点中的序号)、
   *   sourceHash=ab12cd34ef56(该段落源文的哈希)。
   * 旧格式 "52#3" / "52" 仍可解析,sourceHash 为空表示不做内容校验。
   */
  function splitParagraphId(id) {
    const raw = String(id || "");
    const at = raw.lastIndexOf("@");
    const body = at > 0 ? raw.slice(0, at) : raw;
    const sourceHash = at > 0 ? raw.slice(at + 1) : "";
    const [pid, ordinalText] = body.split("#");
    return { pid, ordinal: Number(ordinalText) || 0, sourceHash };
  }
  runtime.splitNovelParagraphId = splitParagraphId;

  /**
   * 段落节点当前源文的哈希。必须与 extractKakaoNovelChapter 用同一套
   * 归一化与哈希,否则合法译文会被误判为错配。
   */
  function computeParagraphSourceHash(node) {
    const text = runtime.getOriginalNovelParagraphText?.(node) ?? String(node?.textContent || "");
    return String(runtime.computeTranslationCacheHash(runtime.normalizeTranslationCacheText(text)) || "");
  }
  runtime.computeNovelParagraphSourceHash = computeParagraphSourceHash;

  function findParagraphNode(surface, id) {
    // 用 id 里的原始 data-p-id 和同 id 序号在当前屏上定位节点。
    const { pid, ordinal } = splitParagraphId(id);
    const escaped = globalThis.CSS?.escape ? CSS.escape(pid) : String(pid).replace(/["\\]/gu, "\\$&");
    const matches = surface?.root?.querySelectorAll?.(`[data-p-id="${escaped}"]`) || [];
    return [...matches].filter(node => /^(?:H[1-6]|P|DIV)$/u.test(String(node.tagName || "")))[ordinal] || null;
  }
  runtime.findNovelParagraphNode = findParagraphNode;

  /**
   * 正向映射:DOM 节点 → 已有段落 id(形如 "52#3")。
   * 必须复用 extractKakaoNovelChapter 的提取结果,因为那里的序号是按数值 id
   * 排序后算出来的;若在这里按 DOM 顺序自行推算,会与侧边栏卡片对不上号。
   */
  function findParagraphIdForNode(surface, node) {
    if (!surface || !node) return null;
    const paragraphs = runtime.extractKakaoNovelChapter?.(surface)?.paragraphs || [];
    for (const paragraph of paragraphs) {
      const candidate = paragraph.node;
      if (!candidate) continue;
      if (candidate === node) return String(paragraph.id || "");
      if (typeof candidate.contains === "function" && candidate.contains(node)) {
        return String(paragraph.id || "");
      }
    }
    return null;
  }
  runtime.findParagraphIdForNode = findParagraphIdForNode;

  function ensureNovelWrappers(node) {
    injectNovelStyles(node.getRootNode());
    let source = node.querySelector?.(":scope > .mt-novel-source");
    let translation = node.querySelector?.(":scope > .mt-novel-translation");
    if (source && translation) return { source, translation };
    source = document.createElement("span");
    source.className = "mt-novel-source";
    source.dataset.mangaTranslatorNovel = "source";
    while (node.firstChild) source.appendChild(node.firstChild);
    translation = document.createElement("span");
    translation.className = "mt-novel-translation";
    translation.dataset.mangaTranslatorNovel = "translation";
    // 页面（含 shadow DOM 内）常设 user-select: none 防复制；inline style 确保正文可选中以添加术语。
    node.style.userSelect = "text";
    node.style.webkitUserSelect = "text";
    source.style.userSelect = "text";
    source.style.webkitUserSelect = "text";
    translation.style.userSelect = "text";
    translation.style.webkitUserSelect = "text";
    node.appendChild(source);
    node.appendChild(translation);
    node.dataset.mtNovelTranslated = "true";
    return { source, translation };
  }

  function renderNovelTranslation(node, translatedText, showTranslation = true) {
    if (!node || !String(translatedText || "").trim()) return false;
    const { source, translation } = ensureNovelWrappers(node);
    translation.textContent = String(translatedText).trim();
    applyVisibility(source, translation, showTranslation);
    if (showTranslation) {
      // 译文按"显示译文"意图渲染后同步翻转全局意图:随后的 reconcile/reapply
      // 以 state.showTranslation 为准,若不翻转会把刚到达的译文重新藏回原文。
      // 切换回原文走 setNovelTranslationVisibility(false),不经由此处,不会误翻转。
      const novelState = runtime.getNovelState?.();
      if (novelState) novelState.showTranslation = true;
    }
    node.dataset.mtNovelTranslated = "true";
    return true;
  }
  runtime.renderNovelTranslation = renderNovelTranslation;

  function applyVisibility(source, translation, showTranslation) {
    const bilingual = runtime.state.displayMode === "bilingual";
    source.hidden = showTranslation && !bilingual;
    translation.hidden = !showTranslation;
    source.classList.toggle("mt-novel-source-bilingual", showTranslation && bilingual);
  }

  function setNovelTranslationVisibility(showTranslation) {
    const surface = runtime.getNovelState().surface || runtime.findKakaoNovelSurface();
    if (!surface) return;
    surface.root.querySelectorAll("[data-mt-novel-translated='true']").forEach(node => {
      const source = node.querySelector(":scope > .mt-novel-source");
      const translation = node.querySelector(":scope > .mt-novel-translation");
      if (!source || !translation) return;
      applyVisibility(source, translation, showTranslation);
    });
    runtime.getNovelState().showTranslation = showTranslation;
    // 译文/原文切换时图片一起切换:显示译文则重新嵌入,恢复原文则还原原图。
    runtime.syncNovelImageVisibility?.(showTranslation, surface);
  }
  runtime.setNovelTranslationVisibility = setNovelTranslationVisibility;

  function restoreNovelNode(node) {
    const source = node?.querySelector?.(":scope > .mt-novel-source");
    const translation = node?.querySelector?.(":scope > .mt-novel-translation");
    if (!source || !translation) return;
    while (source.firstChild) node.insertBefore(source.firstChild, source);
    source.remove();
    translation.remove();
    delete node.dataset.mtNovelTranslated;
  }

  function restoreAllNovelText(root = null) {
    const roots = root ? [root] : collectOpenShadowRoots();
    roots.forEach(candidate => candidate.querySelectorAll?.("[data-mt-novel-translated='true']")
      .forEach(restoreNovelNode));
  }
  runtime.restoreAllNovelText = restoreAllNovelText;

  function collectOpenShadowRoots() {
    const roots = [document];
    document.querySelectorAll?.("*").forEach(node => {
      if (node.shadowRoot) roots.push(node.shadowRoot);
    });
    return roots;
  }

  function reapplyNovelTranslations(surface = runtime.findKakaoNovelSurface()) {
    if (!surface) return;
    const state = runtime.getNovelState();
    state.translations.forEach((text, id) => {
      const node = findParagraphNode(surface, id);
      if (!node) return;
      // 段落 id 自带源文哈希。当前屏上同号段落的源文与译文所属源文对不上,
      // 说明这份译文属于另一屏(EPUB 翻页后 data-p-id 会从 0 重新编号)。
      // 直接套用会把作品开头的句子画到版权页上,必须拒收并清掉错配残影。
      const expected = splitParagraphId(id).sourceHash;
      if (expected && computeParagraphSourceHash(node) !== expected) {
        restoreNovelNode(node);
        return;
      }
      renderNovelTranslation(node, text, state.showTranslation);
    });
  }
  runtime.reapplyNovelTranslations = reapplyNovelTranslations;
}
