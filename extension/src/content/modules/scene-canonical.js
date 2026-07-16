export function installSceneCanonical(runtime) {
  async function renderCanonicalProjections(input = {}) {
    const pages = runtime.normalizeProjectionPages(input);
    const seamSurfaces = runtime.normalizeSeamRenderSurfaces(input)
      .filter((surface) => runtime.isSeamSurfaceRenderable(surface));
    const seamSurfacesByPage = new Map();
    const handledCanonicalIds = new Set();
    const atomicSeamPageIds = new Set();
    seamSurfaces.forEach((surface) => {
      surface.handledCanonicalIds.forEach((id) => handledCanonicalIds.add(id));
      surface.suppressedCanonicalIds.forEach((id) => handledCanonicalIds.add(id));
      surface.pageIds.forEach((pageId) => {
        if (!pages.has(pageId)) pages.set(pageId, []);
        const pageSurfaces = seamSurfacesByPage.get(pageId) || [];
        pageSurfaces.push(surface);
        seamSurfacesByPage.set(pageId, pageSurfaces);
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
    let renderedCount = 0;
    const atomicRenderTasks = [];
    for (const [pageId, projections] of pages.entries()) {
      const target = runtime.getTargetForKakaoPageId(pageId) ||
        (pageId === String(input.pageId || "") ? input.target : null);
      if (!target || !target.isConnected) continue;
      const pageSurfaces = seamSurfacesByPage.get(pageId) || [];
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
        ),
        seamSurfaces: pageSurfaces,
        seamPageId: pageId
      };
      const pageRenderOptions = {
        ...input,
        seamSurfaces: pageSurfaces,
        translationComplete: runtime.getPageMappedValue(
          input.translationCompleteByPage, pageId, input.translationComplete
        ),
        authoritativeEmpty: runtime.getPageMappedValue(
          input.authoritativeEmptyByPage, pageId, input.authoritativeEmpty
        )
      };
      const disposition = runtime.classifyCanonicalProjectionRender(bubbles, pageRenderOptions);
      const invokeRender = (options) => {
        const task = runtime.renderTranslationResult(
          target, targetKey, result,
          runtime.getPageMappedValue(input.payloadByPage, pageId, input.payload || null),
          options
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
          stream: pageSurfaces.length === 0,
          forceOverlay: pageSurfaces.length > 0
        });
        if (task) await task;
        target.dataset.mtNoTextKey = "";
        if (runtime.isCanonicalRenderComplete(ordinaryProjections, pageRenderOptions)) {
          target.dataset.mtLastTranslatedKey = scopedTargetKey;
          runtime.kakaoRetryScheduler.cancel(target);
        } else target.dataset.mtLastTranslatedKey = "";
      } else {
        if (runtime.hasRenderableOcrDebug(result)) {
          const task = invokeRender({ stream: false, debugOnly: input.debugOnly === true });
          if (task) await task;
        } else runtime.clearRenderedTarget(target);
        target.dataset.mtNoTextKey = scopedTargetKey;
        target.dataset.mtLastTranslatedKey = "";
        runtime.kakaoRetryScheduler.cancel(target);
      }
      renderedCount += bubbles.length;
    }
    if (atomicRenderTasks.length) await Promise.all(atomicRenderTasks);
    const seamBubbleCount = seamSurfaces.reduce(
      (count, surface) => count + surface.bubbles.length, 0
    );
    return { ok: true, bubbles: renderedCount + seamBubbleCount };
  }
  runtime.renderCanonicalProjections = renderCanonicalProjections;
}

function isCover(projection) {
  return projection?.role === "cover" || projection?.role === "cover_only" || projection?.coverOnly === true;
}

function isActiveProjection(projection, activeProjectionIds) {
  const rawRole = String(projection?.role || "text_primary");
  const role = rawRole === "primary" ? "text_primary" :
    rawRole === "standby" && projection?.coverOnly === true ? "cover_only" :
      rawRole === "standby" ? "text_standby" : rawRole === "cover" ? "cover_only" : rawRole;
  if (role === "cover_only") return projection?.active !== false;
  if (typeof projection?.activeText === "boolean") return projection.activeText;
  return activeProjectionIds.has(String(projection?.projectionId || projection?.id || ""));
}

function selectActiveProjectionIds(runtime, pages, handledCanonicalIds) {
  const candidatesByCanonical = new Map();
  for (const [pageId, projections] of pages.entries()) {
    for (const projection of projections) {
      const rawRole = String(projection?.role || "text_primary");
      const role = rawRole === "primary" ? "text_primary" : rawRole === "standby" ? "text_standby" : rawRole;
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
