import { installNovelInlineFormat } from "./novel-inline-format.js";

const NOVEL_SHADOW_STYLES = [
  "[data-p-id] .mt-novel-source[hidden],",
  "[data-p-id] .mt-novel-translation[hidden] { display: none !important; }",
  // 包裹层必须是「透明」的:颜色/字体只能从段落本身继承。
  //
  // KakaoPage 的 EPUB 阅读器会在 shadow root 里注入
  // `* { color: rgb(var(--colors-viewer-static-epub-darkgray-text)) !important; }`。
  // 这条 `*` 规则同样命中我们插入的两个 span,而普通(无 !important)的
  // `color: inherit` 压不过它 —— 于是原文里本该继承段落颜色的正文被刷成主题灰。
  // 真机(蓝框 .box01/.box_txt,段落 `color: rgb(0,0,0) !important`):原文是
  // 「黑色正文 + 灰色加粗段」混排,套壳后整段变成同一种灰;切回原文也不恢复。
  // 所以这两个属性必须带 !important,才能让包裹层对页面主题规则完全透明。
  "[data-p-id] .mt-novel-source { display: contents; color: inherit !important; font: inherit !important; }",
  "[data-p-id] .mt-novel-translation { white-space: pre-wrap; color: inherit !important; font: inherit !important; }",
  "[data-p-id] .mt-novel-source-bilingual { display: block; margin-bottom: 0.42em; }",
  "[data-p-id]::selection,",
  "[data-p-id] .mt-novel-source::selection,",
  "[data-p-id] .mt-novel-translation::selection { background: rgba(96, 165, 250, 0.4); color: inherit; }"
].join("\n");

export function installNovelRenderer(runtime) {
  // 行内格式复刻(镜像 + 强调对齐解析)在 novel-inline-format.js:桌面版与手机小说版共用。
  installNovelInlineFormat(runtime);

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
    // 用 id 里的原始锚点值和同锚点序号在当前屏上定位节点。
    // 锚点属性由 surface 决定（Kakao 页面自带 data-p-id、RIDI 我们盖章的
    // data-mt-novel-pid），这里不硬编码属性名。
    const { pid, ordinal } = splitParagraphId(id);
    const attribute = runtime.novelAnchorAttribute?.(surface) || "data-p-id";
    const escaped = globalThis.CSS?.escape ? CSS.escape(pid) : String(pid).replace(/["\\]/gu, "\\$&");
    const matches = surface?.root?.querySelectorAll?.(`[${attribute}="${escaped}"]`) || [];
    // 序号必须与 extractNovelChapter 用同一套判据算出来:那里排除了
    // 「带嵌套段落的容器」(KakaoPage 的论坛块容器与内层段落同号),这里若只按
    // 标签过滤,容器会占掉第 0 个序号,reapply 就会把译文画到容器上,又因源文
    // 哈希不匹配而被清掉(表现为译文静默消失)。runtime 未装 reader 时退回旧判据。
    const isParagraph = node => (typeof runtime.isNovelParagraphLeaf === "function"
      ? runtime.isNovelParagraphLeaf(node, attribute)
      : /^(?:H[1-6]|P|DIV)$/u.test(String(node?.tagName || "")));
    return [...matches].filter(isParagraph)[ordinal] || null;
  }
  runtime.findNovelParagraphNode = findParagraphNode;

  /**
   * 正向映射:DOM 节点 → 已有段落 id(形如 "52#3")。
   * 必须复用 extractNovelChapter 的提取结果,因为那里的序号是按锚点排序后算出来的;
   * 若在这里按 DOM 顺序自行推算,会与侧边栏卡片对不上号。
   */
  function findParagraphIdForNode(surface, node) {
    if (!surface || !node) return null;
    const paragraphs = runtime.extractNovelChapter?.(surface)?.paragraphs || [];
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

  /**
   * 渲染一段译文。
   *
   * paragraphId 用来取这一段「让模型对齐过的行内格式」(state.emphasisMarks);
   * 没对齐过就按字符占比近似映射(见 buildTranslationMirror)。
   *
   * 已经画好、且内容与本次请求完全一致时直接返回:reconcile 会在每次 DOM 变动后
   * 重扫并 reapply,没有这层判断就会「写译文 → 触发观察器 → 再重扫 → 再写译文」，
   * 变成一个每 80ms 重写一遍全文的自我激发循环(RIDI 的内容观察器与 Kakao 的
   * shadow 观察器都会看到自己刚插进去的包裹节点)。
   */
  function renderNovelTranslation(node, translatedText, showTranslation = true, paragraphId = "") {
    const text = String(translatedText || "").trim();
    if (!node || !text) return false;
    const { source, translation } = ensureNovelWrappers(node);
    const marked = paragraphId
      ? runtime.getNovelState?.()?.emphasisMarks?.get(String(paragraphId)) || ""
      : "";
    const key = `${String(paragraphId)}\u0000${marked}\u0000${text}`;
    const novelState = runtime.getNovelState?.();
    const renderedKeys = novelState && (novelState.renderedKeys || (novelState.renderedKeys = new Map()));
    if (renderedKeys && renderedKeys.get(String(paragraphId)) === key && translation.firstChild) {
      applyVisibility(source, translation, showTranslation);
      return true;
    }
    // 先清空再写入:reapply/侧栏改译会重复调用,镜像包裹不能层层叠加。
    translation.textContent = "";
    const mirror = runtime.buildNovelInlineMirror?.(source, text, marked) || null;
    if (mirror) mirror.forEach(child => translation.appendChild(child));
    else translation.textContent = text;
    if (renderedKeys) renderedKeys.set(String(paragraphId), key);
    applyVisibility(source, translation, showTranslation);
    if (showTranslation) {
      // 译文按"显示译文"意图渲染后同步翻转全局意图:随后的 reconcile/reapply
      // 以 state.showTranslation 为准,若不翻转会把刚到达的译文重新藏回原文。
      // 切换回原文走 setNovelTranslationVisibility(false),不经由此处,不会误翻转。
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

  /**
   * 切换译文/原文。
   *
   * 显示原文 = **把正文还原成页面原本的样子**:译文节点与两个包裹节点一起撤掉。
   * 以前只把译文标成 hidden,隐藏的中文仍留在 DOM 里,整段 textContent 成了
   * 「韩文+中文」混排 —— 别的翻译插件据此刻定「这段已经是译文」直接跳过,
   * 用户看到的正是「切换为原文后无法被其他翻译软件翻译」。
   * 译文本身留在 state.translations 里,再点「显示译文」时从这里重新渲染。
   */
  function setNovelTranslationVisibility(showTranslation) {
    const state = runtime.getNovelState();
    const surface = state.surface || runtime.findNovelSurface();
    state.showTranslation = showTranslation;
    if (!surface) return;
    if (showTranslation) {
      // 原文模式下 DOM 里没有可翻转的壳,必须按 state.translations 重贴一遍。
      reapplyNovelTranslations(surface);
    } else {
      state.renderedKeys?.clear();
      restoreAllNovelText(surface.root);
    }
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
    runtime.getNovelState?.().renderedKeys?.clear();
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

  function reapplyNovelTranslations(surface = runtime.findNovelSurface()) {
    if (!surface) return;
    const state = runtime.getNovelState();
    // 原文模式下正文必须保持页面原样:这里若继续套壳,又会把刚还原好的 DOM
    // 改回「隐藏中文 + 透明包裹」的形态(reconcile 每 80ms 就会调到这里)。
    if (!state.showTranslation) return;
    state.translations.forEach((text, id) => {
      const node = findParagraphNode(surface, id);
      if (!node) return;
      // 段落 id 自带源文哈希。当前屏上同锚点段落的源文与译文所属源文对不上,
      // 说明这份译文属于另一屏(EPUB 翻页后 data-p-id 会从 0 重新编号)。
      // 直接套用会把作品开头的句子画到版权页上,必须拒收并清掉错配残影。
      const expected = splitParagraphId(id).sourceHash;
      if (expected && computeParagraphSourceHash(node) !== expected) {
        state.renderedKeys?.delete(String(id));
        restoreNovelNode(node);
        return;
      }
      renderNovelTranslation(node, text, state.showTranslation, id);
    });
  }
  runtime.reapplyNovelTranslations = reapplyNovelTranslations;
}
