export function installNovelRenderer(runtime) {
  function findParagraphNode(surface, id) {
    const escaped = globalThis.CSS?.escape ? CSS.escape(id) : String(id).replace(/["\\]/gu, "\\$&");
    const matches = surface?.root?.querySelectorAll?.(`[data-p-id="${escaped}"]`) || [];
    return [...matches].find(node => /^(?:H[1-6]|P|DIV)$/u.test(String(node.tagName || ""))) || null;
  }

  function ensureNovelWrappers(node) {
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
      renderNovelTranslation(findParagraphNode(surface, id), text, state.showTranslation);
    });
  }
  runtime.reapplyNovelTranslations = reapplyNovelTranslations;
}
