export function installNovelImagePanel(runtime) {
  function getNovelImageResultKey(target, index = 0) {
    const assigned = String(target?.dataset?.mtNovelResultKey || "");
    if (assigned) return assigned;
    const source = String(
      target?.dataset?.name || target?.getAttribute?.("data-src") ||
      target?.currentSrc || target?.src || ""
    );
    const paragraphId = String(target?.getAttribute?.("data-p-id") || "");
    return `novel-image-${runtime.hashSourceIdentity(`${location.href}|${paragraphId}|${index}|${source}`)}`;
  }
  runtime.getNovelImageResultKey = getNovelImageResultKey;

  function getRenderedNovelImageLines(target) {
    const targetId = runtime.state.targetIdByElement.get(target);
    const overlay = targetId ? runtime.state.overlaysById.get(targetId) : null;
    const embedded = targetId ? runtime.state.embeddedById.get(targetId) : null;
    const values = [
      ...(embedded?.translatedLines || []),
      ...Array.from(overlay?.bubbleNodes || []).map(node =>
      String(node?.dataset?.translated || node?.textContent || "").trim()
      )
    ].filter(Boolean);
    return [...new Set(values)];
  }
  runtime.getRenderedNovelImageLines = getRenderedNovelImageLines;

  function classifyNovelImageResult(result, lines, hasRenderedOutput = false) {
    if ((Array.isArray(lines) && lines.length > 0) || hasRenderedOutput) {
      return { status: "complete", error: "" };
    }
    if (!result?.ok) {
      return { status: "failed", error: result?.error || result?.reason || "图片翻译失败" };
    }
    if (Number(result?.bubbles || 0) > 0) {
      return { status: "failed", error: "图片译文已生成，但渲染结果不可用" };
    }
    return { status: "empty", error: "" };
  }
  runtime.classifyNovelImageResult = classifyNovelImageResult;
  function shouldOpenNovelImagePanel(imagePanelOpen, status) {
    return Boolean(imagePanelOpen) || ["failed", "empty"].includes(status);
  }
  runtime.shouldOpenNovelImagePanel = shouldOpenNovelImagePanel;

  function ensureNovelImagePanel() {
    const state = runtime.getNovelState();
    if (state.imagePanel?.isConnected) return state.imagePanel;
    const panel = document.createElement("aside");
    panel.className = "mt-novel-image-panel";
    panel.dataset.mangaTranslatorOverlay = "true";
    panel.dataset.side = runtime.state.floatingSide === "left" ? "left" : "right";
    const header = document.createElement("div");
    header.className = "mt-novel-image-panel-header";
    const title = document.createElement("strong");
    title.textContent = "图片译文";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mt-novel-image-panel-close";
    close.textContent = "×";
    close.title = "关闭图片译文侧栏";
    close.addEventListener("click", event => {
      runtime.stopExtensionUiEvent?.(event);
      state.imagePanelOpen = false;
      panel.hidden = true;
    });
    const body = document.createElement("div");
    body.className = "mt-novel-image-panel-body";
    header.append(title, close);
    panel.append(header, body);
    document.documentElement.appendChild(panel);
    state.imagePanel = panel;
    state.imagePanelBody = body;
    return panel;
  }
  runtime.ensureNovelImagePanel = ensureNovelImagePanel;

  function createResultCard(summary, index) {
    const card = document.createElement("section");
    card.className = `mt-novel-image-result mt-${summary.status}`;
    const preview = document.createElement("img");
    preview.className = "mt-novel-image-preview";
    preview.src = summary.imageUrl;
    preview.alt = `正文图片 ${index + 1}`;
    const content = document.createElement("div");
    content.className = "mt-novel-image-result-content";
    const label = document.createElement("div");
    label.className = "mt-novel-image-result-label";
    label.textContent = `正文图片 ${index + 1}${summary.embeddedDataUrl ? " · 已嵌入" : ""}`;
    const text = document.createElement("div");
    text.className = "mt-novel-image-result-text";
    if (summary.status === "working") text.textContent = "识别与翻译中…";
    else if (summary.status === "empty") text.textContent = "未识别到可翻译文字，可点击“图”重试。";
    else if (summary.status === "failed") text.textContent = summary.error || "图片翻译失败，可点击“图”重试。";
    else text.textContent = summary.lines.join("\n");
    content.append(label, text);
    card.append(preview, content);
    return card;
  }

  function renderNovelImagePanel(open = false) {
    const state = runtime.getNovelState();
    if (open) state.imagePanelOpen = true;
    const panel = ensureNovelImagePanel();
    panel.dataset.side = runtime.state.floatingSide === "left" ? "left" : "right";
    panel.hidden = !state.imagePanelOpen;
    const body = state.imagePanelBody;
    body.replaceChildren();
    const summaries = [...state.imageResults.values()];
    if (summaries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mt-novel-image-panel-empty";
      empty.textContent = "本章尚无图片翻译结果。";
      body.appendChild(empty);
      return panel;
    }
    summaries.forEach((summary, index) => body.appendChild(createResultCard(summary, index)));
    return panel;
  }
  runtime.renderNovelImagePanel = renderNovelImagePanel;
  runtime.openNovelImagePanel = () => renderNovelImagePanel(true);
  runtime.syncNovelImagePanelSide = () => {
    const panel = runtime.getNovelState().imagePanel;
    if (panel) panel.dataset.side = runtime.state.floatingSide === "left" ? "left" : "right";
  };

  function updateNovelImageResult(item, result = null, status = "") {
    const state = runtime.getNovelState();
    const key = item.resultKey || runtime.getNovelImageResultKey(item.target);
    const lines = status === "working" ? [] : runtime.getRenderedNovelImageLines(item.target);
    const targetId = runtime.state.targetIdByElement.get(item.target);
    const embedded = targetId ? runtime.state.embeddedById.get(targetId) : null;
    const currentSource = String(item.target.getAttribute?.("src") || item.target.currentSrc || "");
    const embeddedDataUrl = embedded?.mode === "embedded" && runtime.isDataUrl(currentSource)
      ? currentSource : "";
    const hasRenderedOutput = Boolean(embeddedDataUrl) && Number(embedded?.bubbleCount || 0) > 0;
    const classified = status === "working"
      ? { status: "working", error: "" }
      : runtime.classifyNovelImageResult(result, lines, hasRenderedOutput);
    const summary = {
      key,
      status: classified.status,
      error: classified.error,
      lines,
      imageUrl: embeddedDataUrl || String(item.target.currentSrc || item.target.src || ""),
      embeddedDataUrl,
      targetKey: String(embedded?.targetKey || ""),
      bubbleCount: Number(embedded?.bubbleCount || 0),
      paragraphId: String(item.target.getAttribute?.("data-p-id") || "")
    };
    state.imageResults.set(key, summary);
    renderNovelImagePanel(runtime.shouldOpenNovelImagePanel(
      state.imagePanelOpen, classified.status
    ));
    return summary;
  }
  runtime.updateNovelImageResult = updateNovelImageResult;

  function reapplyNovelEmbeddedImages(surface) {
    const state = runtime.getNovelState();
    // 显示原文时不重新嵌入,避免滚动/虚拟列表重建节点把译文图片又贴回去。
    if (state.showTranslation !== true) return 0;
    const content = surface?.content || surface?.root;
    if (!content?.querySelectorAll || state.imageResults.size === 0) return 0;
    let restored = 0;
    [...content.querySelectorAll("img")].filter(target =>
      runtime.isNovelContentImage?.(target)
    ).forEach((target, index) => {
      const key = runtime.getNovelImageResultKey(target, index);
      const summary = state.imageResults.get(key);
      target.dataset.mtNovelResultKey = key;
      if (!summary?.embeddedDataUrl || !runtime.isDataUrl(summary.embeddedDataUrl)) return;
      target.dataset.mtNovelImage = "true";
      if (target.getAttribute("src") === summary.embeddedDataUrl &&
          target.dataset.mtEmbeddedActive === "true") return;
      runtime.applyEmbeddedImageDataUrl(target, summary.targetKey || key, summary.embeddedDataUrl, {
        bubbleCount: summary.bubbleCount,
        translatedLines: summary.lines
      });
      restored += 1;
    });
    return restored;
  }
  runtime.reapplyNovelEmbeddedImages = reapplyNovelEmbeddedImages;

  function syncNovelImageVisibility(showTranslation, surface) {
    if (!surface) return;
    if (showTranslation) {
      runtime.reapplyNovelEmbeddedImages?.(surface);
      return;
    }
    // 恢复原文:把所有已嵌入的正文图片还原为原图。
    const content = surface.content || surface.root;
    if (!content?.querySelectorAll) return;
    [...content.querySelectorAll("img")].forEach(img => {
      if (img.dataset?.mtEmbeddedActive === "true" && runtime.isNovelContentImage?.(img)) {
        runtime.restoreEmbeddedForTarget(img);
      }
    });
  }
  runtime.syncNovelImageVisibility = syncNovelImageVisibility;

  function clearNovelImagePanel(remove = false) {
    const state = runtime.getNovelState();
    state.imageResults.clear();
    state.imagePanelOpen = false;
    if (remove) {
      state.imagePanel?.remove();
      state.imagePanel = null;
      state.imagePanelBody = null;
    } else if (state.imagePanel) {
      state.imagePanel.hidden = true;
      state.imagePanelBody?.replaceChildren();
    }
  }
  runtime.clearNovelImagePanel = clearNovelImagePanel;
}
