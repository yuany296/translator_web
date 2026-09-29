import { isCoverProjection, normalizeProjectionRole } from "../../shared/projection-role.js";

export function installSceneCanonical(runtime) {
  async function renderCanonicalProjections(input = {}) {
    const pages = runtime.normalizeProjectionPages(input);
    const inspectedSurfaces = runtime.normalizeSeamRenderSurfaces(input).map(surface => ({
      surface,
      inspection: runtime.inspectSeamSurfaceRenderability(surface)
    }));
    if (input.target?.dataset) input.target.dataset.mtSeamRenderDiagnostics = JSON.stringify(inspectedSurfaces.map(item => ({
      renderKey: item.surface.renderKey,
      ...item.inspection
    })));
    const seamSurfaces = inspectedSurfaces.filter(item => item.inspection.ok).map(item => item.surface);
    const allSurfaceInput = Array.isArray(input.allSeamSurfaces) ? input.allSeamSurfaces : input.seamSurfaces;
    const allSeamSurfaces = runtime.normalizeSeamRenderSurfaces({ seamSurfaces: allSurfaceInput })
      .filter(surface => runtime.inspectSeamSurfaceRenderability(surface).ok);
    const handledCanonicalIds = new Set();
    const atomicSeamPageIds = new Set();
    seamSurfaces.forEach((surface) => {
      surface.handledCanonicalIds.forEach((id) => handledCanonicalIds.add(id));
      surface.absorbedCanonicalIds.forEach((id) => handledCanonicalIds.add(id));
      surface.pageIds.forEach((pageId) => {
        if (!pages.has(pageId)) pages.set(pageId, []);
        atomicSeamPageIds.add(pageId);
      });
    });

    // DOM revision 在提交瞬间变化时，保留尚未被 seam surface 接管的稳定逐页投影。
    const fallbackPages = runtime.normalizeProjectionPages({
      projectionsByPage: input?.fallbackProjectionsByPage
    });
    for (const [pageId, fallbackProjections] of fallbackPages.entries()) {
      if (!pages.has(pageId)) pages.set(pageId, []);
      const current = pages.get(pageId);
      const existingKeys = new Set(current.map((projection) => String(
        projection?.projectionId || projection?.id || `${projection?.canonicalId || ""}|${projection?.role || ""}`
      )));
      for (const projection of fallbackProjections) {
        const canonicalId = String(projection?.canonicalId || projection?.groupId || "");
        if (canonicalId && handledCanonicalIds.has(canonicalId)) continue;
        const key = String(
          projection?.projectionId || projection?.id || `${canonicalId}|${projection?.role || ""}`
        );
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        current.push(projection);
      }
    }

    const activeProjectionIds = selectActiveProjectionIds(runtime, pages, handledCanonicalIds);
    // 逐页记录"这一页渲染时到底有没有清理图、上游判定原因是什么"。
    // 复杂背景旁白没有 inpainted 遮罩时，只有把这两侧对起来才知道该修哪一步
    // （页面渲染没带上图 / 上游根本没请求 / 请求被跳过）。发布到 <html data-mt-mask-render>。
    const maskRows = new Map();
    const maskReasonFor = pageId => {
      try {
        const store = runtime.state.kakaoStore;
        const report = store && typeof store.getCleanedArtifactReport === "function" ? store.getCleanedArtifactReport() : [];
        const key = String(pageId || "").replace(/^page-/, "").slice(0, 8);
        const hit = report.find(item => item && item.p === key);
        return hit ? hit.r : "";
      } catch {
        return "";
      }
    };
    let renderedCount = 0;
    const atomicRenderTasks = [];
    for (const [pageId, projections] of pages.entries()) {
      const target = runtime.getTargetForKakaoPageId(pageId) ||
        (pageId === String(input.pageId || "") ? input.target : null);
      if (!target || !target.isConnected) continue;
      const ordinaryProjections = [...projections].filter((projection) => {
        const canonicalId = String(projection?.canonicalId || projection?.groupId || "");
        return !canonicalId || !handledCanonicalIds.has(canonicalId);
      });
      const bubbles = ordinaryProjections
        .sort((left, right) => Number(!isCover(left)) - Number(!isCover(right)))
        .filter((projection) => isActiveProjection(projection, activeProjectionIds))
        .map(runtime.projectionToRendererBubble)
        .filter((bubble) => bubble.w > 0 && bubble.h > 0)
        .filter((bubble) => bubble.projection_role === "cover_only" || bubble.translated_text);
      const targetKey = runtime.computeTargetKey(target);
      const scopedTargetKey = runtime.buildTargetSourceCacheKey(
        targetKey, runtime.getQuickSourceToken(target)
      );
      const result = {
        bubbles,
        cleanedImage: runtime.getPageMappedValue(
          input.cleanedImageByPage, pageId, input.result?.cleanedImage || null
        ),
        debug: runtime.getPageMappedValue(
          input.debugByPage, pageId, input.debug || input.result?.debug || null
        )
      };
      // 渲染侧驱动补清理图：这一页要画的是 bg_type=none 的透明遮罩、手里却没有
      // 清理图 → 把"它到底盖了哪几块"直接报给 canonical 层去补一张。
      // 不走投影计划，所以不受"这一页此刻是否可见 / 是否被 seam 接管"影响。
      runtime.traceMaskEvent?.(pageId, "render-input", {
        in: runtime.isDataUrl(result.cleanedImage) ? 1 : 0,
        argLen: String(input.result && input.result.cleanedImage || "").length,
        mapped: runtime.isDataUrl(runtime.getPageMappedValue(input.cleanedImageByPage, pageId, null)) ? 1 : 0,
        n: bubbles.length
      });
      if (!runtime.isDataUrl(result.cleanedImage)) {
        const maskBoxes = bubbles
          .filter(bubble => bubble && bubble.projection_role === "cover_only" &&
            runtime.normalizeBgType(bubble.bg_type) === "none")
          .map(bubble => ({ x: bubble.x, y: bubble.y, w: bubble.w, h: bubble.h }))
          .filter(box => Number(box.w) > 0 && Number(box.h) > 0);
        if (maskBoxes.length > 0) {
          Promise.resolve(runtime.kakaoCanonicalPipeline?.requestMissingPageMask?.(pageId, maskBoxes)).catch(() => {});
        }
      }
      const pageRenderOptions = {
        ...input,
        pageId,
        translationComplete: runtime.getPageMappedValue(
          input.translationCompleteByPage, pageId, input.translationComplete
        ),
        authoritativeEmpty: runtime.getPageMappedValue(
          input.authoritativeEmptyByPage, pageId, input.authoritativeEmpty
        )
      };
      // 每一页都在这里记一行（含 no-text / pending），否则最后一轮只渲染一页时
      // 诊断属性里就只剩那一页，看不出"哪些分片没拿到清理图"。
      if (maskRows.size < 24 || maskRows.has(String(pageId))) {
        maskRows.set(String(pageId), {
          p: String(pageId || "").replace(/^page-/, "").slice(0, 8),
          in: runtime.isDataUrl(result.cleanedImage) ? 1 : 0,
          r: maskReasonFor(pageId),
          n: bubbles.length,
          out: 0
        });
      }
      const disposition = runtime.classifyCanonicalProjectionRender(bubbles, pageRenderOptions);
      const invokeRender = (options) => {
        const task = runtime.renderTranslationResult(
          target, targetKey, result,
          runtime.getPageMappedValue(input.payloadByPage, pageId, input.payload || null),
          { ...options, pageId }
        );
        if (atomicSeamPageIds.has(pageId)) {
          atomicRenderTasks.push(task);
          return null;
        }
        return task;
      };
      if (disposition === "pending") {
        if (runtime.hasRenderableOcrDebug(result)) {
          const task = invokeRender({ stream: false, debugOnly: true });
          if (task) await task;
        }
        if (input.debugOnly !== true) {
          target.dataset.mtLastTranslatedKey = "";
          target.dataset.mtNoTextKey = "";
        }
        continue;
      }
      runtime.rememberLocalResult(scopedTargetKey, result);
      if (disposition === "translated") {
        const task = invokeRender({
          stream: !atomicSeamPageIds.has(pageId),
          forceOverlay: atomicSeamPageIds.has(pageId)
        });
        if (task) await task;
        // 记录渲染后 DOM 的真实结果：进这一页的清理图和真画上去的是不是同一件事。
        const rendered = runtime.state.overlaysById && runtime.state.overlaysById.get(runtime.getTargetId(target));
        const row = maskRows.get(String(pageId));
        if (row) {
          row.out = rendered && rendered.root
            ? (rendered.root.style.getPropertyValue("--mt-cleaned-image") ? 1 : 0) : -1;
        }
        target.dataset.mtNoTextKey = "";
        if (runtime.isCanonicalRenderComplete(ordinaryProjections, pageRenderOptions)) {
          target.dataset.mtLastTranslatedKey = scopedTargetKey;
          runtime.kakaoRetryScheduler.cancel(target);
        } else target.dataset.mtLastTranslatedKey = "";
      } else {
        if (runtime.hasRenderableOcrDebug(result)) {
          const task = invokeRender({ stream: false, debugOnly: input.debugOnly === true });
          if (task) await task;
        } else {
          runtime.removeOverlayForTarget(target);
          runtime.restoreEmbeddedForTarget(target);
        }
        target.dataset.mtNoTextKey = scopedTargetKey;
        target.dataset.mtLastTranslatedKey = "";
        runtime.kakaoRetryScheduler.cancel(target);
      }
      renderedCount += bubbles.length;
    }
    try {
      const root = typeof document !== "undefined" ? document.documentElement : null;
      if (root && root.dataset) root.dataset.mtMaskRender = JSON.stringify([...maskRows.values()]);
    } catch {
      // 诊断属性只是便利设施
    }
    if (atomicRenderTasks.length) await Promise.all(atomicRenderTasks);
    // canonical refresh 会逐页提交普通 projection；每次都携带同一份全局 surface snapshot，
    // 避免后续无关页面的空 seam 输入误删刚安装的跨页 overlay。
    const seamBubbleCount = runtime.renderCrossPageSurfaces(allSeamSurfaces);
    return { ok: true, bubbles: renderedCount + seamBubbleCount };
  }
  runtime.renderCanonicalProjections = renderCanonicalProjections;
}

function isCover(projection) {
  return isCoverProjection(projection);
}

function isActiveProjection(projection, activeProjectionIds) {
  const role = normalizeProjectionRole(projection?.role, projection?.coverOnly);
  if (role === "cover_only") return projection?.active !== false;
  if (typeof projection?.activeText === "boolean") return projection.activeText;
  return activeProjectionIds.has(String(projection?.projectionId || projection?.id || ""));
}

function selectActiveProjectionIds(runtime, pages, handledCanonicalIds) {
  const candidatesByCanonical = new Map();
  for (const [pageId, projections] of pages.entries()) {
    for (const projection of projections) {
      // 与 isActiveProjection 用同一份 role 归一：以前这里少了 coverOnly 分支，
      // 于是 standby+coverOnly 的投影被当成文字候选选进来（同一块既当遮罩又当文字）。
      const role = normalizeProjectionRole(projection?.role, projection?.coverOnly);
      const canonicalId = String(projection?.canonicalId || projection?.groupId || projection?.id || "");
      if (!["text_primary", "text_standby"].includes(role) || !canonicalId ||
          handledCanonicalIds.has(canonicalId) || !runtime.getTargetForKakaoPageId(pageId)) continue;
      const candidates = candidatesByCanonical.get(canonicalId) || [];
      candidates.push({ pageId, projection, role });
      candidatesByCanonical.set(canonicalId, candidates);
    }
  }
  const selectedIds = new Set();
  for (const candidates of candidatesByCanonical.values()) {
    candidates.sort((left, right) => Number(left.role !== "text_primary") -
      Number(right.role !== "text_primary") || String(left.pageId).localeCompare(String(right.pageId)));
    const selected = candidates.find(({ projection }) => projection.activeText === true) ||
      candidates.find(({ projection }) => projection.active !== false) || candidates[0];
    selectedIds.add(String(selected.projection.projectionId || selected.projection.id || ""));
  }
  return selectedIds;
}
