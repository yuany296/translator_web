/**
 * 覆盖层几何取证（只读）。
 *
 * 背景：接缝处会跑三次 OCR（上片、下片、合起来的 composite），reconciler 只让一份当
 * `primary`，其余标成 `standby`，而 standby 气泡在 `configure.js` 就被滤掉——所以
 * 「有 root 却没有几何 / display:none」本身是设计内的抑制结果。
 *
 * 需要确认的是**残留壳**：root 是在该 canonical 还是 primary 时建的，角色翻成 standby
 * 之后 root 只是被 0×0 的 target rect 顺带藏起来，并没有删除。滚动回视口让 rect 恢复
 * 有效时，壳里的旧 bubble 节点可能复活，把已经不成立的旧译文重新显示出来。
 * 这个报告把「谁被藏了」「藏起来的壳里写着什么」「同一个 canonical 有没有两个不同译文」
 * 一次性列出来，供人判断是纯残留还是真缺陷。
 */
export function installDiagnosticsOverlay(runtime) {
  function roundRect(rect) {
    if (!rect) return null;
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function safeRect(node) {
    try {
      return roundRect(node.getBoundingClientRect());
    } catch {
      return null;
    }
  }

  function describeBubbles(nodes) {
    return (Array.isArray(nodes) ? nodes : []).filter(Boolean).map(node => ({
      canonicalId: String(node.dataset.canonicalId || ""),
      role: String(node.dataset.projectionRole || ""),
      blockId: String(node.dataset.blockId || ""),
      translated: String(node.dataset.translated || "").slice(0, 80),
      visibility: String(node.style.visibility || ""),
      inlineFontSize: String(node.style.fontSize || ""),
      rect: safeRect(node)
    }));
  }

  /** 收集同一个 canonical 在各处的译文，找出「同一 id 两个不同译文」的冲突。 */
  function trackCanonical(byCanonical, canonicalId, translated, where) {
    const id = String(canonicalId || "");
    const text = String(translated || "").trim();
    if (!id || !text) return;
    const bucket = byCanonical.get(id) || [];
    bucket.push({ where, translated: text.slice(0, 80) });
    byCanonical.set(id, bucket);
  }

  function reportOverlayGeometry() {
    const byCanonical = new Map();
    const roots = [];
    runtime.state.overlaysById.forEach(overlayState => {
      if (!overlayState) return;
      const root = overlayState.root;
      const bubbles = describeBubbles(overlayState.bubbleNodes);
      bubbles.forEach(bubble => trackCanonical(byCanonical, bubble.canonicalId, bubble.translated, `overlay:${overlayState.targetId}`));
      roots.push({
        targetId: String(overlayState.targetId || ""),
        targetKey: String(overlayState.targetKey || "").slice(0, 60),
        targetTag: overlayState.target && overlayState.target.tagName ? overlayState.target.tagName.toLowerCase() : "",
        targetConnected: Boolean(overlayState.target && overlayState.target.isConnected),
        targetRect: overlayState.target ? safeRect(overlayState.target) : null,
        displayRectSource: overlayState.displayRect ? "payload" : "target",
        hasImageMeta: Boolean(overlayState.imageMeta),
        displayRect: safeRect({ getBoundingClientRect: () => runtime.getOverlayDisplayRect(overlayState) }),
        rootConnected: Boolean(root && root.isConnected),
        rootDisplay: root ? String(root.style.display || "") : "",
        rootInline: root ? {
          left: String(root.style.left || ""),
          top: String(root.style.top || ""),
          width: String(root.style.width || ""),
          height: String(root.style.height || "")
        } : null,
        rootRect: root ? safeRect(root) : null,
        bubbleCount: Number(overlayState.bubbleCount || 0),
        bubbles
      });
    });

    const surfaces = Array.from(document.querySelectorAll(".mt-cross-page-overlay")).map(overlay => {
      const textNode = overlay.querySelector(".mt-cross-page-text");
      const translated = String(textNode && textNode.dataset.translated || "");
      const canonicalId = String(overlay.dataset.canonicalId || "");
      trackCanonical(byCanonical, canonicalId, translated, `seam:${String(overlay.dataset.seamRenderKey || "")}`);
      return {
        canonicalId,
        seamRenderKey: String(overlay.dataset.seamRenderKey || ""),
        translated: translated.slice(0, 80),
        rect: safeRect(overlay),
        textVisible: Boolean(textNode && textNode.isConnected)
      };
    });

    // 同一 canonical 出现两个不同译文 → 说明有一份是旧值仍在 DOM 里（壳复活的证据）。
    const conflicts = [];
    byCanonical.forEach((entries, canonicalId) => {
      const distinct = [...new Set(entries.map(entry => entry.translated))];
      if (distinct.length > 1) conflicts.push({ canonicalId, entries });
    });

    const seamCanonicalIds = new Set(surfaces.map(surface => surface.canonicalId).filter(Boolean));
    roots.forEach(root => {
      const ids = root.bubbles.map(bubble => bubble.canonicalId).filter(Boolean);
      root.hiddenByDisplay = root.rootDisplay === "none";
      root.coveredBySeam = ids.length > 0 && ids.every(id => seamCanonicalIds.has(id));
      root.husk = root.hiddenByDisplay && root.coveredBySeam;
    });

    return {
      href: String(location && location.href || ""),
      generatedAt: new Date().toISOString(),
      roots,
      surfaces,
      conflicts,
      summary: {
        roots: roots.length,
        visibleRoots: roots.filter(root => !root.hiddenByDisplay).length,
        huskRoots: roots.filter(root => root.husk).length,
        seamSurfaces: surfaces.length,
        conflicts: conflicts.length
      }
    };
  }
  runtime.reportOverlayGeometry = reportOverlayGeometry;

  /** 页面控制台一行取证：__mtOverlayGeometryReport() */
  function exposeConsoleHelper() {
    try {
      const scope = typeof window === "undefined" ? null : window;
      if (!scope || scope.__mtOverlayGeometryReport) return;
      scope.__mtOverlayGeometryReport = () => {
        const report = reportOverlayGeometry();
        console.info("[MangaTranslator] overlay geometry report", report.summary);
        return report;
      };
    } catch {
      // 控制台助手只是便利设施，注册失败不影响渲染
    }
  }
  runtime.exposeOverlayGeometryConsoleHelper = exposeConsoleHelper;
  exposeConsoleHelper();
}
