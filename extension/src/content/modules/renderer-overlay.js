export function installRendererOverlay(runtime) {
  function renderOverlay(target, targetKey, result, options = {}) {
    const bubbles = Array.isArray(result.bubbles) ? result.bubbles : [];
    const stream = options.stream === true;
    if (bubbles.length === 0 && !runtime.hasRenderableOcrDebug(result)) {
      runtime.removeOverlayForTarget(target);
      return;
    }
    runtime.ensureOverlayLayer();
    const targetId = runtime.getTargetId(target);
    const oldOverlay = runtime.state.overlaysById.get(targetId);
    const currentSourceToken = runtime.getQuickSourceToken(target);
    const hasTranslatedRenderContent = bubbles.length > 0;
    const renderSignature = hasTranslatedRenderContent ? runtime.buildOverlayRenderSignature(result) : runtime.buildOverlayDebugRenderSignature(result);
    // 清理图（inpainted 遮罩图）有三个来源，取第一个非空的：
    //
    // 1) result.cleanedImage —— canonical 层这次带上来的图。最准，但它是「渲染那一刻
    //    的快照」；清理图是异步产物，图落地时这一版投影往往已经画完。
    // 2) oldOverlay.cleanedImage —— 这枚 root 上已绑好的图。不能要求 sourceToken 未变：
    //    清理图是「页级」产物（按 pageId 缓存），与这一片的图源地址是两件事，RIDI
    //    分片换 url 时同一页的清理图仍然有效。旧写法在这里丢掉沿用值 → 新 root 没
    //    变量 → syncOverlayPosition 按"这一层没有清理图"撤掉变量，正是"有的有有的没有"。
    // 3) store 里这一页此刻的 handle.cleanedImage —— 兜底。前两个都扑空说明覆盖层是在
    //    图落地之后才（重）建的：绑过一次的那枚 root 已被换掉。问 store 最准。
    const argMask = String(result && result.cleanedImage || "");
    const carriedMask = String(oldOverlay && oldOverlay.cleanedImage || "");
    const storeMask = String(runtime.getPageCleanedImage?.(options.pageId) || "");
    const cleanedImage = String(argMask || carriedMask || storeMask || "");
    const maskEv = { arg: argMask.length, carried: carriedMask.length, store: storeMask.length, eff: cleanedImage.length };

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
    // 走到这里 = 要重建 root。eff 为 0 就说明新 root 天生没有遮罩。
    runtime.traceMaskEvent?.(options.pageId, "rebuild", maskEv);
    const root = document.createElement("div");
    root.className = "mt-overlay-root";
    root.dataset.mangaTranslatorOverlay = "true";
    root.dataset.targetId = targetId;
    // 取证标签：sync-write 时记进流水，即可判断写入的是不是此刻 DOM 里那枚 root。
    runtime.state.overlayProbeSeq = (Number(runtime.state.overlayProbeSeq) || 0) + 1;
    root.dataset.mtProbe = `${targetId}:${runtime.state.overlayProbeSeq}`;
    // 覆盖层与 pageId 的对应关系：诊断遮罩问题时要能和 data-mt-mask-* 的分片对上。
    if (options.pageId) root.dataset.pageId = String(options.pageId);
    const maskValue = runtime.maskCssValue?.(cleanedImage);
    if (maskValue) root.style.setProperty("--mt-cleaned-image", maskValue);
    const debugNodeCount = runtime.appendOcrDebugNodes(root, result);
    const bubbleNodes = [];
    const coverNodes = [];
    let logicalBubbleCount = 0;
    const backgroundTarget = runtime.IS_PIXIV_COMIC_VIEWER && runtime.isBackgroundImageTarget(target);
    bubbles.forEach((bubble, index) => {
      const { coverNode, textNode } = runtime.createBubbleRenderNodes(bubble, index, { backgroundTarget });
      if (!coverNode && !textNode) return;
      logicalBubbleCount += 1;
      if (coverNode) {
        coverNodes.push(runtime.createBubbleCoverClipNode(bubble, coverNode));
      }
      if (textNode && stream) {
        const delayMs = Math.min(index * 34, 320);
        textNode.classList.add("mt-stream-enter");
        textNode.style.setProperty("--mt-stream-delay", `${delayMs}ms`);
      }
      if (textNode) {
        bubbleNodes.push(textNode);
      }
    });
    if (logicalBubbleCount === 0 && debugNodeCount === 0) {
      return;
    }
    runtime.appendBubbleRenderLayers(root, coverNodes, bubbleNodes);
    const overlayState = {
      target,
      targetId,
      pageId: options.pageId ? String(options.pageId) : "",
      targetKey,
      sourceToken: currentSourceToken,
      root,
      bubbleNodes,
      coverNodes,
      bubbleCount: logicalBubbleCount,
      isBackgroundTarget: backgroundTarget,
      mode: logicalBubbleCount > 0 ? "bubbles" : "debug",
      debugNodeCount,
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
    runtime.syncOverlayPosition(overlayState);
    if (!bubbles.some(bubble => bubble && bubble.canonical_id)) {
      runtime.syncKakaoVisualDuplicateBubbles(true);
    }
    runtime.ensureOverlayFrameSync();
    runtime.logOcrDebugMapping(overlayState, result);
    if (result && result.debug) {
      console.info("[MangaTranslator][OCR chain] rendered", {
        frontendRenderedOverlays: bubbleNodes.length,
        frontendRenderedDebugBoxes: debugNodeCount,
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
      bubbleCount: logicalBubbleCount,
      debugNodeCount,
      targetKey: String(targetKey).slice(0, 80)
    });
  }
  runtime.renderOverlay = renderOverlay;
  function appendBubbleRenderLayers(root, coverNodes, textNodes) {
    // 所有背景先绘制、所有译文后绘制。即使相邻蓝框非常接近，任何背景
    // 节点也不能凭 DOM 顺序盖住另一个文字节点。
    (Array.isArray(coverNodes) ? coverNodes : []).forEach(node => root.appendChild(node));
    (Array.isArray(textNodes) ? textNodes : []).forEach(node => root.appendChild(node));
  }
  runtime.appendBubbleRenderLayers = appendBubbleRenderLayers;
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
    // 分片阅读器的相邻片各带一小段重叠像素，同一句可能被两片各渲染一次；
    // 视觉去重把重复的那一枚藏掉，KakaoPage 与 RIDI 共用同一判据。
    if (!runtime.IS_STRIP_TILE_READER || !runtime.KP || typeof runtime.KP.selectKakaoVisualDuplicateLoser !== "function") {
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
  function formatOcrDebugConfidence(item) {
    const raw = item && item.raw;
    const candidates = [
      item && item.confidence,
      item && item.recognitionConfidence,
      item && item.recognition_confidence,
      item && item.recScore,
      item && item.rec_score,
      item && item.textScore,
      item && item.text_score,
      item && item.score,
      raw && (raw.confidence ?? raw.rec_score ?? raw.text_score ?? raw.score)
    ];
    const value = candidates.find(candidate => candidate !== null && candidate !== undefined && candidate !== "");
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return "";
    const count = Math.max(0, Math.round(Number(item && (item.confidenceCount ?? item.confidence_count)) || 0));
    const average = Number(item && (item.confidenceAverage ?? item.confidence_average));
    const minimum = Number(item && (item.confidenceMinimum ?? item.confidence_minimum));
    if (count > 1 && Number.isFinite(average) && Number.isFinite(minimum)) {
      const averagePercent = average <= 1 ? average * 100 : average;
      const minimumPercent = minimum <= 1 ? minimum * 100 : minimum;
      return `OCR avg ${averagePercent.toFixed(1)}% min ${minimumPercent.toFixed(1)}%`;
    }
    const percent = numeric <= 1 ? numeric * 100 : numeric;
    return `OCR ${percent.toFixed(1)}%`;
  }
  runtime.formatOcrDebugConfidence = formatOcrDebugConfidence;
  function appendOcrDebugNodes(root, result) {
    const debug = result && result.debug;
    if (!debug || !root) {
      return 0;
    }
    let appended = 0;
    const stages = runtime.getRenderableOcrDebugStages(debug);
    const hasAnyPolygon = stages.some(stage =>
      (Array.isArray(stage.items) ? stage.items : []).some(item => Array.isArray(item && item.polygon))
    );
    // Create SVG overlay for polygon rendering
    let svg = null;
    if (hasAnyPolygon) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "mt-debug-svg");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("data-manga-translator-overlay", "true");
    }
    stages.forEach(stage => {
      (Array.isArray(stage.items) ? stage.items : []).forEach((item, index) => {
        const blockId = String(item.blockId || item.block_id || item.id || `${stage.name}-${index}`);
        const original = String(item.text || item.originalText || "").replace(/\s+/g, " ").slice(0, 28);
        const translated = String(item.translatedText || item.translated_text || "").replace(/\s+/g, " ").slice(0, 28);
        const duplicate = item.isDuplicate ? " duplicate" : "";
        const confidence = runtime.formatOcrDebugConfidence(item);
        const label = `${blockId}${duplicate}${confidence ? ` [${confidence}]` : ""}${original ? ` | ${original}` : ""}${translated ? ` → ${translated}` : ""}`;
        if (Array.isArray(item.polygon) && item.polygon.length >= 4) {
          // Oriented polygon — render as SVG <polygon>
          if (!svg) {
            svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("class", "mt-debug-svg");
            svg.setAttribute("viewBox", "0 0 100 100");
            svg.setAttribute("preserveAspectRatio", "none");
            svg.setAttribute("data-manga-translator-overlay", "true");
          }
          const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
          poly.setAttribute("class", `mt-debug-poly ${stage.className} mt-debug-stage-${stage.name}`);
          poly.setAttribute("points", item.polygon.map(p => `${p.x},${p.y}`).join(" "));
          poly.setAttribute("data-manga-translator-overlay", "true");
          // <title> for hover tooltip
          const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
          title.textContent = label;
          poly.appendChild(title);
          svg.appendChild(poly);
          // Label div at polygon's local top-left corner (minU, minV)
          const labelDiv = document.createElement("div");
          labelDiv.className = `mt-debug-label ${stage.className} mt-debug-stage-${stage.name}`;
          labelDiv.dataset.label = label;
          labelDiv.dataset.mangaTranslatorOverlay = "true";
          labelDiv.style.left = `${item.polygon[0].x}%`; labelDiv.style.top = `${item.polygon[0].y}%`;
          labelDiv.style.transform = `rotate(${runtime.resolveBubblePolygonRotation(item.polygon, item.rotation_deg ?? item.rotationDeg, debug.imageWidth, debug.imageHeight)}deg)`;
          labelDiv.style.transformOrigin = "left bottom";
          root.appendChild(labelDiv);
        } else {
          // No polygon — fall back to axis-aligned debug box
          const percent = runtime.getDebugItemPercent(item, debug);
          if (!percent) return;
          const node = document.createElement("div");
          node.className = `mt-debug-box ${stage.className} mt-debug-stage-${stage.name}`;
          node.style.left = `${percent.x}%`;
          node.style.top = `${percent.y}%`;
          node.style.width = `${percent.w}%`;
          node.style.height = `${percent.h}%`;
          node.dataset.label = label;
          node.dataset.mangaTranslatorOverlay = "true";
          root.appendChild(node);
        }
        appended += 1;
      });
    });
    if (svg && svg.childElementCount > 0) {
      root.insertBefore(svg, root.firstChild);
    }
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
