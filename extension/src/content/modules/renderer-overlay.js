export function installRendererOverlay(runtime) {
  function removeDuplicateSeamSurfaceRoots(seamSurfaces, keepRoot, pageId = "") {
    const renderKeys = runtime.getSeamSurfaceRenderKeys(seamSurfaces);
    const sliceKeys = runtime.getSeamSurfaceSliceKeys(seamSurfaces, pageId);
    if (renderKeys.size === 0 || !runtime.state.overlayLayer) return;
    for (const root of Array.from(runtime.state.overlayLayer.querySelectorAll(".mt-overlay-root"))) {
      if (root === keepRoot) continue;
      const hasSliceKeys = String(root.dataset && root.dataset.seamSliceKeys || "").trim();
      const isSameSlice = hasSliceKeys ? runtime.rootHasAnySeamSliceKey(root, sliceKeys) : runtime.rootHasAnySeamRenderKey(root, renderKeys);
      if (!isSameSlice) continue;
      const rootTargetId = String(root.dataset && root.dataset.targetId || "");
      const overlayState = rootTargetId ? runtime.state.overlaysById.get(rootTargetId) : null;
      if (overlayState && overlayState.root === root) {
        if (overlayState.loadingTimeout) {
          window.clearTimeout(overlayState.loadingTimeout);
          overlayState.loadingTimeout = 0;
        }
        runtime.state.overlaysById.delete(rootTargetId);
      }
      root.remove();
    }
  }
  runtime.removeDuplicateSeamSurfaceRoots = removeDuplicateSeamSurfaceRoots;
  function renderOverlay(target, targetKey, result, options = {}) {
    const bubbles = Array.isArray(result.bubbles) ? result.bubbles : [];
    const seamSurfaces = Array.isArray(result && result.seamSurfaces) ? result.seamSurfaces : [];
    const stream = options.stream === true;

    // 旧版 seam renderer 可能在扩展热更新后留下不受 overlaysById 管理的根节点。
    // canonical renderer 是唯一跨页渲染入口，新的页面结果到达时应立即清理旧根。
    runtime.removeSeamCrossPageOverlays(target);
    if (bubbles.length === 0 && seamSurfaces.length === 0 && !runtime.hasRenderableOcrDebug(result)) {
      runtime.removeOverlayForTarget(target);
      return;
    }
    runtime.ensureOverlayLayer();
    const targetId = runtime.getTargetId(target);
    const oldOverlay = runtime.state.overlaysById.get(targetId);
    const currentSourceToken = runtime.getQuickSourceToken(target);
    const hasTranslatedRenderContent = bubbles.length > 0 || seamSurfaces.some(surface => Array.isArray(surface && surface.bubbles) && surface.bubbles.length > 0);
    const renderSignature = hasTranslatedRenderContent ? runtime.buildOverlayRenderSignature(result) : runtime.buildOverlayDebugRenderSignature(result);
    const cleanedImage = String(result && result.cleanedImage || "");
    if (oldOverlay && oldOverlay.targetKey === targetKey && oldOverlay.sourceToken === currentSourceToken) {
      // OCR debug 是中间态，不能为了显示诊断框先删掉已经稳定可见的译文。
      if (options.debugOnly === true && Number(oldOverlay.bubbleCount || 0) > 0) {
        runtime.syncOverlayPosition(oldOverlay);
        return;
      }
      // canonical 的全局 reconcile 可能多次提交完全相同的页面；相同结果只同步位置，
      // 保留 root 与 bubble node 身份，避免肉眼可见的闪烁。
      if (runtime.isSameOverlayRenderPayload(oldOverlay, renderSignature, cleanedImage)) {
        oldOverlay.imageMeta = Object.prototype.hasOwnProperty.call(options, "imageMeta") ? options.imageMeta : oldOverlay.imageMeta || null;
        oldOverlay.displayRect = Object.prototype.hasOwnProperty.call(options, "displayRect") ? options.displayRect : oldOverlay.displayRect || null;
        runtime.syncOverlayPosition(oldOverlay);
        return;
      }
    }
    const root = document.createElement("div");
    root.className = "mt-overlay-root";
    root.dataset.mangaTranslatorOverlay = "true";
    root.dataset.targetId = targetId;
    root.dataset.seamRenderKeys = seamSurfaces.map(surface => surface.renderKey).join(" ");
    const seamPageId = String(result && result.seamPageId || runtime.state.kakaoPageIdByTarget.get(target) || "");
    root.dataset.seamPageId = seamPageId;
    root.dataset.seamSliceKeys = runtime.getSeamSurfaceSliceKeys(seamSurfaces, seamPageId).size > 0 ? Array.from(runtime.getSeamSurfaceSliceKeys(seamSurfaces, seamPageId)).join(" ") : "";
    if (result && runtime.isDataUrl(result.cleanedImage)) {
      root.style.setProperty("--mt-cleaned-image", `url("${result.cleanedImage}")`);
    }
    const debugNodeCount = runtime.appendOcrDebugNodes(root, result);
    const seamEntries = seamSurfaces.map(surface => runtime.createSeamWindowNode(surface, seamPageId)).filter(Boolean);
    root.dataset.seamSliceKeys = seamEntries.map(entry => runtime.buildSeamSurfaceSliceKey(entry.surface && entry.surface.renderKey, entry.pageId)).filter(Boolean).join(" ");
    seamEntries.forEach(entry => root.appendChild(entry.windowNode));
    const seamBubbleCount = seamEntries.reduce((count, entry) => count + entry.bubbleNodes.length, 0);
    const seamDebugNodeCount = seamEntries.reduce((count, entry) => count + entry.debugNodeCount, 0);
    const bubbleNodes = [];
    const backgroundTarget = runtime.IS_PIXIV_COMIC_VIEWER && runtime.isBackgroundImageTarget(target);
    bubbles.forEach((bubble, index) => {
      const bubbleNode = runtime.createBubbleNode(bubble, index, {
        backgroundTarget
      });
      if (bubbleNode) {
        if (stream) {
          const delayMs = Math.min(index * 34, 320);
          bubbleNode.classList.add("mt-stream-enter");
          bubbleNode.style.setProperty("--mt-stream-delay", `${delayMs}ms`);
        }
        bubbleNodes.push(bubbleNode);
        root.appendChild(bubbleNode);
      }
    });
    if (bubbleNodes.length === 0 && seamBubbleCount === 0 && debugNodeCount + seamDebugNodeCount === 0) {
      return;
    }
    const overlayState = {
      target,
      targetId,
      targetKey,
      sourceToken: currentSourceToken,
      root,
      bubbleNodes,
      seamEntries,
      bubbleCount: bubbleNodes.length + seamBubbleCount,
      isBackgroundTarget: backgroundTarget,
      mode: bubbleNodes.length + seamBubbleCount > 0 ? "bubbles" : "debug",
      debugNodeCount: debugNodeCount + seamDebugNodeCount,
      renderSignature,
      cleanedImage,
      imageMeta: options.imageMeta || null,
      displayRect: options.displayRect || null
    };
    if (oldOverlay) {
      if (oldOverlay.loadingTimeout) {
        window.clearTimeout(oldOverlay.loadingTimeout);
        oldOverlay.loadingTimeout = 0;
      }
      if (oldOverlay.root && oldOverlay.root.isConnected && typeof oldOverlay.root.replaceWith === "function") {
        oldOverlay.root.replaceWith(root);
      } else {
        runtime.state.overlayLayer.appendChild(root);
      }
    } else {
      runtime.state.overlayLayer.appendChild(root);
    }
    runtime.state.overlaysById.set(targetId, overlayState);
    runtime.removeDuplicateSeamSurfaceRoots(seamSurfaces, root, seamPageId);
    runtime.syncOverlayPosition(overlayState);
    if (!bubbles.some(bubble => bubble && bubble.canonical_id)) {
      runtime.syncKakaoVisualDuplicateBubbles(true);
    }
    runtime.ensureOverlayFrameSync();
    runtime.logOcrDebugMapping(overlayState, result);
    if (result && result.debug) {
      console.info("[MangaTranslator][OCR chain] rendered", {
        frontendRenderedOverlays: bubbleNodes.length + seamBubbleCount,
        frontendRenderedDebugBoxes: debugNodeCount + seamDebugNodeCount,
        targetKey,
        targetId
      });
    }
    if (stream) {
      bubbleNodes.forEach((node, index) => {
        const clearDelay = Math.min(index * 34, 320) + 420;
        window.setTimeout(() => {
          if (node.isConnected) {
            node.classList.remove("mt-stream-enter");
            node.style.removeProperty("--mt-stream-delay");
          }
        }, clearDelay);
      });
    }
    runtime.tracePipeline("rendered", target, {
      bubbleCount: bubbleNodes.length + seamBubbleCount,
      debugNodeCount: debugNodeCount + seamDebugNodeCount,
      targetKey: String(targetKey).slice(0, 80)
    });
  }
  runtime.renderOverlay = renderOverlay;
  function scheduleTermDiscovery(target, targetKey, result, payload) {
    if (runtime.state.invalidated) {
      return;
    }
    const sourceIdentity = String(payload && (payload.sourceImageId || payload.sourceToken) || runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target)));
    const message = runtime.buildTermDiscoveryMessage(result, targetKey, sourceIdentity, location.href, document.title);
    if (!message) {
      return;
    }
    const sendKey = `${message.pageUrl}|${message.targetKey}|${runtime.hashSourceIdentity(JSON.stringify(message.blocks))}`;
    if (runtime.state.termDiscoverySentKeys.has(sendKey)) {
      return;
    }
    runtime.state.termDiscoverySentKeys.add(sendKey);
    if (runtime.state.termDiscoverySentKeys.size > 500) {
      runtime.state.termDiscoverySentKeys.delete(runtime.state.termDiscoverySentKeys.values().next().value);
    }
    runtime.sendRuntimeMessage(message).catch(() => {
      // 术语发现是旁路能力，离线或扩展重载都不能影响译文渲染。
    });
  }
  runtime.scheduleTermDiscovery = scheduleTermDiscovery;
  function buildTermDiscoveryMessage(result, targetKey, sourceIdentity, pageUrl, pageTitle) {
    const imageId = `image-${runtime.hashSourceIdentity(`${targetKey}|${sourceIdentity}`)}`;
    const blocks = (result && Array.isArray(result.bubbles) ? result.bubbles : []).map((bubble, index) => {
      if (bubble && bubble.projection_role === "cover_only") {
        return null;
      }
      const originalText = String(bubble && bubble.original_text || "").trim();
      if (!originalText) {
        return null;
      }
      const translatedText = String(bubble && bubble.translated_text || "").trim();
      const rawBlockId = String(bubble && (bubble.block_id || bubble.id) || index);
      const evidenceHash = runtime.hashSourceIdentity(`${rawBlockId}|${originalText}`);
      return {
        id: `${imageId}-${evidenceHash}`,
        originalText,
        translatedText
      };
    }).filter(Boolean);
    if (blocks.length === 0) {
      return null;
    }
    return {
      type: "DISCOVER_TERMS",
      pageUrl: String(pageUrl || ""),
      pageTitle: String(pageTitle || ""),
      targetKey: imageId,
      blocks
    };
  }
  runtime.buildTermDiscoveryMessage = buildTermDiscoveryMessage;
  function syncKakaoVisualDuplicateBubbles(force = false) {
    if (!runtime.IS_KAKAOPAGE_READER || !runtime.KP || typeof runtime.KP.selectKakaoVisualDuplicateLoser !== "function") {
      return;
    }
    const now = performance.now();
    if (!force && now - runtime.state.lastKakaoVisualDedupeAt < 120) {
      return;
    }
    runtime.state.lastKakaoVisualDedupeAt = now;

    // 每次按当前视口重新计算。之前隐藏的 overflow 在 owner 离开视口后必须恢复，
    // 否则滚动时会把唯一仍可见的译文永久留在隐藏状态。
    runtime.state.overlaysById.forEach(overlayState => {
      if (!overlayState || !Array.isArray(overlayState.bubbleNodes)) return;
      overlayState.bubbleNodes.forEach(node => {
        if (!node || node.dataset.mtVisualDedupeHidden !== "true") return;
        node.style.removeProperty("visibility");
        delete node.dataset.mtVisualDedupeHidden;
      });
    });
    const candidates = [];
    runtime.state.overlaysById.forEach(overlayState => {
      if (!overlayState || !overlayState.root || !overlayState.root.isConnected) return;
      if (overlayState.root.style.display === "none") return;
      overlayState.bubbleNodes.forEach(node => {
        if (!node || !node.isConnected) return;
        if (node.dataset.canonicalId) return;
        const rect = node.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return;
        candidates.push({
          overlayState,
          node,
          descriptor: {
            scopeKey: overlayState.targetKey,
            regionType: String(node.dataset.regionType || ""),
            stitchOverflow: node.dataset.stitchOverflow === "true",
            originalText: String(node.dataset.original || ""),
            translatedText: String(node.dataset.translated || ""),
            box: {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height
            }
          }
        });
      });
    });
    const removed = new Set();
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      const left = candidates[leftIndex];
      if (removed.has(left.node)) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        const right = candidates[rightIndex];
        if (removed.has(right.node)) continue;
        const loserSide = runtime.KP.selectKakaoVisualDuplicateLoser(left.descriptor, right.descriptor);
        if (!loserSide) continue;
        const loser = loserSide === "left" ? left : right;
        loser.node.style.visibility = "hidden";
        loser.node.dataset.mtVisualDedupeHidden = "true";
        removed.add(loser.node);
        if (loser === left) break;
      }
    }
  }
  runtime.syncKakaoVisualDuplicateBubbles = syncKakaoVisualDuplicateBubbles;
  function appendOcrDebugNodes(root, result) {
    const debug = result && result.debug;
    if (!debug || !root) {
      return 0;
    }
    let appended = 0;
    const stages = runtime.getRenderableOcrDebugStages(debug);
    stages.forEach(stage => {
      (Array.isArray(stage.items) ? stage.items : []).forEach((item, index) => {
        const percent = runtime.getDebugItemPercent(item, debug);
        if (!percent) {
          return;
        }
        const node = document.createElement("div");
        node.className = `mt-debug-box ${stage.className}`;
        node.style.left = `${percent.x}%`;
        node.style.top = `${percent.y}%`;
        node.style.width = `${percent.w}%`;
        node.style.height = `${percent.h}%`;
        const blockId = String(item.blockId || item.block_id || item.id || `${stage.name}-${index}`);
        const original = String(item.text || item.originalText || "").replace(/\s+/g, " ").slice(0, 28);
        const translated = String(item.translatedText || item.translated_text || "").replace(/\s+/g, " ").slice(0, 28);
        const duplicate = item.isDuplicate ? " duplicate" : "";
        node.dataset.label = `${blockId}${duplicate}${original ? ` | ${original}` : ""}${translated ? ` → ${translated}` : ""}`;
        node.dataset.mangaTranslatorOverlay = "true";
        root.appendChild(node);
        appended += 1;
      });
    });
    return appended;
  }
  runtime.appendOcrDebugNodes = appendOcrDebugNodes;
  function getDebugItemPercent(item, debug) {
    if (item && item.percent && [item.percent.x, item.percent.y, item.percent.w, item.percent.h].every(value => Number.isFinite(Number(value)))) {
      return item.percent;
    }
    const box = item && (item.rawBox || item.box);
    const imageWidth = Math.max(1, Number(debug && debug.imageWidth) || 1);
    const imageHeight = Math.max(1, Number(debug && debug.imageHeight) || 1);
    if (!box || ![box.left, box.top, box.width, box.height].every(value => Number.isFinite(Number(value)))) {
      return null;
    }
    return {
      x: Number(box.left) / imageWidth * 100,
      y: Number(box.top) / imageHeight * 100,
      w: Number(box.width) / imageWidth * 100,
      h: Number(box.height) / imageHeight * 100
    };
  }
  runtime.getDebugItemPercent = getDebugItemPercent;
}
