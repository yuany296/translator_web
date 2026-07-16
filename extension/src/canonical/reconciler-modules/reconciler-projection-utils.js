export function installReconcilerProjectionUtils(runtime) {
  function pageCoverIsEligible(geometries) {
    const values = Array.isArray(geometries) ? geometries : [];
    if (values.some(geometry => geometry && geometry.sourceType !== "seam")) return true;
    const evidence = runtime.chooseProjectionEvidence(values);
    const visual = evidence && evidence.visual && typeof evidence.visual === "object" ? evidence.visual : {};
    const bgType = String(visual.bgType || visual.bg_type || "none").trim().toLowerCase();
    return bgType !== "solid";
  }
  function buildRenderProjections({
    pages: pageInputs = [],
    canonicals = [],
    availablePageIds,
    translations = {}
  } = {}) {
    const pages = runtime.sortPages(pageInputs);
    const pageById = new Map(pages.map(page => [page.pageId, page]));
    const pageIndex = new Map(pages.map((page, index) => [page.pageId, index]));
    const available = availablePageIds == null ? new Set(pages.map(page => page.pageId)) : new Set(availablePageIds);
    const projections = [];
    for (const canonical of canonicals) {
      const pageIds = Object.keys(canonical.geometryByPage || {}).filter(pageId => pageById.has(pageId)).sort((left, right) => pageIndex.get(left) - pageIndex.get(right) || left.localeCompare(right));
      if (!pageIds.length) continue;
      const preferredPrimaryPageId = [...pageIds].sort((left, right) => {
        const areaDifference = runtime.geometryAreaOnPage(canonical.geometryByPage[right], pageById.get(right)) - runtime.geometryAreaOnPage(canonical.geometryByPage[left], pageById.get(left));
        return (Math.abs(areaDifference) > 1e-9 ? areaDifference : 0) || pageIndex.get(left) - pageIndex.get(right) || left.localeCompare(right);
      })[0];
      const activePageId = available.has(preferredPrimaryPageId) ? preferredPrimaryPageId : pageIds.find(pageId => available.has(pageId)) || null;
      const translatedText = runtime.readTranslation(translations, canonical);
      function addProjection(pageId, role, activeText, active, coverOnly) {
        const geometries = canonical.geometryByPage[pageId];
        const coverEligible = pageCoverIsEligible(geometries);
        const box = runtime.unionGeometry(geometries);
        const evidence = runtime.chooseProjectionEvidence(geometries);
        const visualBox = evidence?.box ? runtime.normalizeBox(evidence.box) : box;
        const visual = runtime.projectionVisualForEvidence(evidence, visualBox);
        const projectionId = `projection_${runtime.stableHash([canonical.id, canonical.revision, pageId, role])}`;
        projections.push(runtime.deepFreeze({
          id: projectionId,
          projectionId,
          canonicalId: canonical.id,
          canonicalRevision: canonical.revision,
          revision: canonical.revision,
          pageId,
          preferredPrimaryPageId,
          role,
          active,
          activeText,
          coverOnly,
          coverEligible,
          originalText: canonical.originalText,
          original_text: canonical.originalText,
          translatedText: activeText ? translatedText : "",
          translated_text: activeText ? translatedText : "",
          geometry: box,
          box,
          visualBox,
          visual,
          geometries,
          bubble: {
            block_id: `${canonical.id}:${role}`,
            canonical_id: canonical.id,
            canonical_revision: canonical.revision,
            original_text: canonical.originalText,
            translated_text: activeText ? translatedText : "",
            x: box.left,
            y: box.top,
            w: box.width,
            h: box.height,
            visual,
            fill_box: visual.fill_box || visual.fillBox || visualBox,
            bg_type: visual.bg_type || visual.bgType || "none",
            bg_color: visual.bg_color || visual.bgColor || "",
            bg_confidence: Number(visual.bg_confidence || visual.bgConfidence || 0),
            region_id: String(visual.region_id || visual.regionId || ""),
            region_type: String(visual.region_type || visual.regionType || "plain_text"),
            region_polygon: visual.region_polygon || visual.regionPolygon || null,
            polygon: visual.polygon || null,
            font_weight: visual.font_weight || visual.fontWeight || 0,
            translation_role: visual.translation_role || visual.translationRole || "",
            projection_role: role,
            projection_active: active,
            cover_only: coverOnly
          }
        }));
      }
      for (const pageId of pageIds) {
        if (pageId === preferredPrimaryPageId) {
          addProjection(pageId, "primary", pageId === activePageId, pageId === activePageId, false);
          continue;
        }
        // seam-only 几何没有该页自己的 OCR 权威证据；它由 seam surface 负责，
        // 不得在普通页面通道额外绘制一个可能落在空白处的纯色 cover。
        if (pageCoverIsEligible(canonical.geometryByPage[pageId])) addProjection(pageId, "cover", false, available.has(pageId), true);
        addProjection(pageId, "standby", pageId === activePageId, pageId === activePageId, false);
      }
    }
    return runtime.deepFreeze(runtime.arbitrateActiveTextProjections(projections).sort((left, right) => (pageIndex.get(left.pageId) ?? 0) - (pageIndex.get(right.pageId) ?? 0) || left.geometry.top - right.geometry.top || left.geometry.left - right.geometry.left || left.canonicalId.localeCompare(right.canonicalId)));
  }
  runtime.buildRenderProjections = buildRenderProjections;
}
