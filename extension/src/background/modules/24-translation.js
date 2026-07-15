export function installBackground24(runtime) {
  function shouldCoalesceOcrCandidateGroups(leftGroup, rightGroup) {
    const left = runtime.getPercentBubbleGroupBox(leftGroup);
    const right = runtime.getPercentBubbleGroupBox(rightGroup);
    if (!left || !right) {
      return false;
    }
    if (leftGroup.some(item => item && item.non_translate === true) || rightGroup.some(item => item && item.non_translate === true)) {
      return false;
    }
    if (runtime.isChatOcrCandidateGroup(leftGroup) || runtime.isChatOcrCandidateGroup(rightGroup)) {
      return false;
    }
    const leftBgType = runtime.normalizeBgType(leftGroup[0] && leftGroup[0].bg_type);
    const rightBgType = runtime.normalizeBgType(rightGroup[0] && rightGroup[0].bg_type);
    const leftRegionId = String(leftGroup[0] && leftGroup[0].region_id || "");
    const rightRegionId = String(rightGroup[0] && rightGroup[0].region_id || "");
    if (leftRegionId || rightRegionId) {
      // 带区域标识的本地 OCR 候选已经完成了行与段落聚类；此处再次按相同 region_id 合并，
      // 会把刻意拆开的气泡边缘补充语、异体字或不同段落重新粘回正文。
      return false;
    }
    if (leftBgType !== rightBgType) {
      return false;
    }
    const leftRegionType = String(leftGroup[0] && leftGroup[0].region_type || "plain_text");
    const rightRegionType = String(rightGroup[0] && rightGroup[0].region_type || "plain_text");
    if (leftRegionType !== rightRegionType && leftRegionType !== "plain_text" && rightRegionType !== "plain_text") {
      return false;
    }
    const heightRatio = Math.min(left.height, right.height) / Math.max(left.height, right.height);
    if (heightRatio < 0.65) {
      return false;
    }
    const leftTime = runtime.CHAT_TIME_RE.test(String(leftGroup[0] && leftGroup[0].original_text || ""));
    const rightTime = runtime.CHAT_TIME_RE.test(String(rightGroup[0] && rightGroup[0].original_text || ""));
    if (leftTime !== rightTime) {
      return false;
    }
    if (runtime.rotationDistance(leftGroup[0] && leftGroup[0].rotation_deg, rightGroup[0] && rightGroup[0].rotation_deg) > 18) {
      return false;
    }
    const overlapWidth = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
    const overlapHeight = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    const overlapArea = overlapWidth * overlapHeight;
    const overlapRatio = overlapArea / Math.max(0.1, Math.min(left.width * left.height, right.width * right.height));
    const horizontalOverlap = overlapWidth / Math.max(0.1, Math.min(left.width, right.width));
    const centerDistanceX = Math.abs(left.centerX - right.centerX);
    const unionWidth = Math.max(left.right, right.right) - Math.min(left.left, right.left);
    const unionHeight = Math.max(left.bottom, right.bottom) - Math.min(left.top, right.top);
    return overlapRatio >= 0.22 && horizontalOverlap >= 0.18 && centerDistanceX <= Math.max(left.width, right.width) * 0.82 && unionWidth <= 96 && unionHeight <= 72;
  }
  runtime.shouldCoalesceOcrCandidateGroups = shouldCoalesceOcrCandidateGroups;
  function isChatOcrCandidateGroup(group) {
    return (Array.isArray(group) ? group : []).some(item => runtime.isChatOcrCandidate(item));
  }
  runtime.isChatOcrCandidateGroup = isChatOcrCandidateGroup;
  function sortOcrCandidatesByReadingOrder(group) {
    const items = (Array.isArray(group) ? group : []).filter(Boolean);
    if (items.length <= 1) {
      return [...items];
    }
    const rotation = runtime.medianRotation(items.map(item => item && item.rotation_deg));
    const rows = runtime.buildProjectedReadingRows(items.map((item, index) => {
      const box = runtime.getPercentBubbleBox(item);
      if (!box) return null;
      return {
        item,
        index,
        box,
        text: String(item && item.original_text || ""),
        point: runtime.projectPointForReadingOrder(box.centerX, box.centerY, rotation),
        lineHeight: Math.max(0.1, runtime.getProjectedPolygonLineThickness(item && item.polygon, rotation) || Math.min(box.width, box.height))
      };
    }).filter(Boolean));
    return rows.flatMap(row => row.entries.sort((left, right) => left.point.inline - right.point.inline || left.index - right.index).map(entry => entry.item));
  }
  runtime.sortOcrCandidatesByReadingOrder = sortOcrCandidatesByReadingOrder;
  function inferOcrCandidateGroupAlignment(group) {
    const explicit = (Array.isArray(group) ? group : []).map(item => runtime.normalizeOcrTextAlignment(item && item.alignment)).filter(alignment => alignment !== "center");
    if (explicit.length > 0) {
      return explicit[0];
    }
    return runtime.inferTextAlignmentFromBoxes((Array.isArray(group) ? group : []).map(runtime.getPercentBubbleBox).filter(Boolean), {
      width: 100,
      height: 100
    }, group && group[0] && group[0].region_type);
  }
  runtime.inferOcrCandidateGroupAlignment = inferOcrCandidateGroupAlignment;
  function projectPointForReadingOrder(centerX, centerY, rotation) {
    const radians = runtime.normalizeRotationDegrees(rotation) * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
      inline: centerX * cos + centerY * sin,
      line: -centerX * sin + centerY * cos
    };
  }
  runtime.projectPointForReadingOrder = projectPointForReadingOrder;
  function buildProjectedReadingRows(entries) {
    const rows = [];
    entries.forEach(entry => {
      let row = rows.find(candidate => Math.abs(candidate.line - entry.point.line) <= Math.max(candidate.height, entry.lineHeight) * 0.72);
      if (!row) {
        row = {
          line: entry.point.line,
          height: entry.lineHeight,
          entries: []
        };
        rows.push(row);
      }
      row.entries.push(entry);
      row.line = row.entries.reduce((sum, item) => sum + item.point.line, 0) / row.entries.length;
      row.height = Math.max(row.height, entry.lineHeight);
    });
    return runtime.orientProjectedRowsVisualTopFirst(rows);
  }
  runtime.buildProjectedReadingRows = buildProjectedReadingRows;
  function orientProjectedRowsVisualTopFirst(rows) {
    const sorted = [...rows].sort((left, right) => left.line - right.line);
    if (sorted.length < 2) {
      return sorted;
    }
    const rowTop = row => Math.min(...row.entries.map(entry => Number(entry.box.top) || 0));
    const firstTop = rowTop(sorted[0]);
    const lastTop = rowTop(sorted[sorted.length - 1]);
    const tolerance = Math.max(...sorted.map(row => Number(row.height) || 0)) * 0.35;
    if (firstTop > lastTop + tolerance) {
      sorted.reverse();
    }
    return sorted;
  }
  runtime.orientProjectedRowsVisualTopFirst = orientProjectedRowsVisualTopFirst;
  function mergeOcrCandidateGroup(group, index) {
    const sorted = runtime.sortOcrCandidatesByReadingOrder(group);
    const box = runtime.getPercentBubbleGroupBox(sorted);
    const requestedBgType = runtime.normalizeBgType(sorted[0] && sorted[0].bg_type);
    const mergedFillBox = requestedBgType === "solid" ? runtime.mergePercentFillBoxes(sorted) : null;
    const mergedTextArea = Math.max(0.01, box.width * box.height);
    const hasSafeSolidFill = requestedBgType !== "solid" || mergedFillBox && mergedFillBox.w * mergedFillBox.h <= mergedTextArea * 2;
    const bgType = hasSafeSolidFill ? requestedBgType : "none";
    const rawBoxes = sorted.map(item => item.rawBox).filter(Boolean);
    const rawLeft = rawBoxes.length > 0 ? Math.min(...rawBoxes.map(box => Number(box.left) || 0)) : 0;
    const rawTop = rawBoxes.length > 0 ? Math.min(...rawBoxes.map(box => Number(box.top) || 0)) : 0;
    const rawRight = rawBoxes.length > 0 ? Math.max(...rawBoxes.map(box => (Number(box.left) || 0) + (Number(box.width) || 0))) : 0;
    const rawBottom = rawBoxes.length > 0 ? Math.max(...rawBoxes.map(box => (Number(box.top) || 0) + (Number(box.height) || 0))) : 0;
    return {
      ...sorted[0],
      id: `t${index}`,
      x: runtime.clamp(box.left, 0, 100),
      y: runtime.clamp(box.top, 0, 100),
      w: runtime.clamp(box.width, 0.1, 100),
      h: runtime.clamp(box.height, 0.1, 100),
      original_text: sorted.map(item => String(item.original_text || "").trim()).filter(Boolean).join("\n"),
      translated_text: "",
      fill_box: bgType === "solid" ? mergedFillBox : null,
      bg_type: bgType,
      bg_color: bgType === "solid" ? String(sorted[0] && sorted[0].bg_color || "") : "",
      bg_confidence: Number(sorted[0] && sorted[0].bg_confidence || 0),
      region_id: String(sorted[0] && sorted[0].region_id || ""),
      region_type: String(sorted[0] && sorted[0].region_type || "plain_text"),
      region_polygon: sorted[0] && sorted[0].region_polygon || null,
      text_color: bgType === "none" ? "#000000" : String(sorted[0] && sorted[0].text_color || ""),
      stroke_color: bgType === "none" ? "#ffffff" : String(sorted[0] && sorted[0].stroke_color || ""),
      alignment: runtime.inferOcrCandidateGroupAlignment(sorted),
      translation_role: runtime.inferOcrCandidateGroupTranslationRole(sorted),
      font_weight: runtime.inferOcrCandidateGroupFontWeight(sorted),
      polygon: runtime.mergePercentPolygons(sorted),
      rotation_deg: runtime.medianRotation(sorted.map(item => item.rotation_deg)),
      source_line_count: Math.max(1, ...sorted.map(item => Number(item.source_line_count) || 1)),
      confidence: Math.max(...sorted.map(item => Number(item.confidence || 0))),
      ...(rawBoxes.length > 0 ? {
        rawBox: {
          left: rawLeft,
          top: rawTop,
          width: rawRight - rawLeft,
          height: rawBottom - rawTop
        }
      } : {})
    };
  }
  runtime.mergeOcrCandidateGroup = mergeOcrCandidateGroup;
  function inferOcrCandidateGroupTranslationRole(group) {
    const roles = (Array.isArray(group) ? group : []).map(item => runtime.normalizeChatTranslationRole(item && (item.translation_role || item.translationRole))).filter(Boolean);
    return roles[0] || "";
  }
  runtime.inferOcrCandidateGroupTranslationRole = inferOcrCandidateGroupTranslationRole;
  function inferOcrCandidateGroupFontWeight(group) {
    const weights = (Array.isArray(group) ? group : []).map(item => runtime.normalizeOcrFontWeight(item && (item.font_weight || item.fontWeight))).filter(weight => weight > 0).sort((left, right) => left - right);
    if (weights.length > 0) {
      return weights[Math.floor(weights.length / 2)];
    }
    return runtime.getChatRoleFontWeight(runtime.inferOcrCandidateGroupTranslationRole(group));
  }
  runtime.inferOcrCandidateGroupFontWeight = inferOcrCandidateGroupFontWeight;
  function mergePercentFillBoxes(items) {
    const boxes = items.map(item => item && item.fill_box).filter(box => box && [box.x, box.y, box.w, box.h].every(value => Number.isFinite(Number(value))) && Number(box.w) > 0 && Number(box.h) > 0);
    if (boxes.length !== items.length || boxes.length === 0) {
      return null;
    }
    const left = Math.min(...boxes.map(box => Number(box.x)));
    const top = Math.min(...boxes.map(box => Number(box.y)));
    const right = Math.max(...boxes.map(box => Number(box.x) + Number(box.w)));
    const bottom = Math.max(...boxes.map(box => Number(box.y) + Number(box.h)));
    return {
      x: runtime.clamp(left, 0, 100),
      y: runtime.clamp(top, 0, 100),
      w: runtime.clamp(right - left, 0.1, 100),
      h: runtime.clamp(bottom - top, 0.1, 100)
    };
  }
  runtime.mergePercentFillBoxes = mergePercentFillBoxes;
  function medianRotation(values) {
    const angles = values.map(runtime.normalizeRotationDegrees).sort((left, right) => left - right);
    return angles.length > 0 ? angles[Math.floor(angles.length / 2)] : 0;
  }
  runtime.medianRotation = medianRotation;
  function mergePercentPolygons(items) {
    const points = items.flatMap(item => Array.isArray(item && item.polygon) ? item.polygon : []);
    if (points.length < 4) {
      return items[0] && items[0].polygon ? items[0].polygon : null;
    }
    const rotation = runtime.medianRotation(items.map(item => item.rotation_deg));
    const radians = rotation * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const projected = points.map(point => ({
      x: point.x * cos + point.y * sin,
      y: -point.x * sin + point.y * cos
    }));
    const minX = Math.min(...projected.map(point => point.x));
    const maxX = Math.max(...projected.map(point => point.x));
    const minY = Math.min(...projected.map(point => point.y));
    const maxY = Math.max(...projected.map(point => point.y));
    const inverse = (x, y) => ({
      x: runtime.clamp(x * cos - y * sin, 0, 100),
      y: runtime.clamp(x * sin + y * cos, 0, 100)
    });
    return [inverse(minX, minY), inverse(maxX, minY), inverse(maxX, maxY), inverse(minX, maxY)];
  }
  runtime.mergePercentPolygons = mergePercentPolygons;
  function collapseDuplicateLocalPaddleTranslations(bubbles) {
    if (!Array.isArray(bubbles) || bubbles.length <= 1) {
      return Array.isArray(bubbles) ? bubbles : [];
    }
    const result = [];
    const used = new Set();
    const sorted = bubbles.map((bubble, index) => ({
      bubble,
      index
    })).sort((left, right) => Number(left.bubble.y || 0) - Number(right.bubble.y || 0));
    for (let i = 0; i < sorted.length; i += 1) {
      if (used.has(sorted[i].index)) {
        continue;
      }
      const group = [sorted[i].bubble];
      used.add(sorted[i].index);
      for (let j = i + 1; j < sorted.length; j += 1) {
        if (used.has(sorted[j].index)) {
          continue;
        }
        if (runtime.shouldCollapseDuplicateTranslationGroup(group, sorted[j].bubble)) {
          group.push(sorted[j].bubble);
          used.add(sorted[j].index);
        }
      }
      result.push(group.length > 1 ? runtime.mergeDuplicateTranslationBubbles(group) : group[0]);
    }
    return result.sort((left, right) => Number(left.y || 0) - Number(right.y || 0) || Number(left.x || 0) - Number(right.x || 0));
  }
  runtime.collapseDuplicateLocalPaddleTranslations = collapseDuplicateLocalPaddleTranslations;
  function shouldCollapseDuplicateTranslationGroup(group, bubble) {
    const baseText = runtime.normalizeDuplicateTranslationText(group[0] && group[0].translated_text);
    const nextText = runtime.normalizeDuplicateTranslationText(bubble && bubble.translated_text);
    if (!baseText || !nextText) {
      return false;
    }
    const exactDuplicate = baseText === nextText && baseText.length >= 8;
    const shorterText = baseText.length <= nextText.length ? baseText : nextText;
    const longerText = baseText.length > nextText.length ? baseText : nextText;
    const containedDuplicate = shorterText.length >= 3 && longerText.includes(shorterText);
    if (!exactDuplicate && !containedDuplicate) {
      return false;
    }
    const groupBox = runtime.getPercentBubbleGroupBox(group);
    const nextBox = runtime.getPercentBubbleBox(bubble);
    if (!groupBox || !nextBox) {
      return false;
    }
    const verticalGap = runtime.getPercentBoxGapY(groupBox, nextBox);
    const overlapX = Math.min(groupBox.right, nextBox.right) - Math.max(groupBox.left, nextBox.left);
    const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(groupBox.width, nextBox.width)) : 0;
    const centerDistance = Math.abs(groupBox.centerX - nextBox.centerX);
    const unionWidth = Math.max(groupBox.right, nextBox.right) - Math.min(groupBox.left, nextBox.left);
    const avgHeight = Math.max(1, (groupBox.height + nextBox.height) / 2);
    if (containedDuplicate && !exactDuplicate) {
      const groupRegionId = String(group[0] && group[0].region_id || "");
      const nextRegionId = String(bubble && bubble.region_id || "");
      const sameRegion = Boolean(groupRegionId && groupRegionId === nextRegionId);
      const closeOverlap = verticalGap <= avgHeight * 0.35 && (overlapRatio >= 0.35 || centerDistance <= Math.max(groupBox.width, nextBox.width) * 0.35);
      return unionWidth <= 86 && (sameRegion || closeOverlap);
    }
    return verticalGap <= avgHeight * 2.4 && unionWidth <= 86 && (overlapRatio >= 0.12 || centerDistance <= 26);
  }
  runtime.shouldCollapseDuplicateTranslationGroup = shouldCollapseDuplicateTranslationGroup;
  function mergeDuplicateTranslationBubbles(group) {
    const box = runtime.getPercentBubbleGroupBox(group);
    const preferred = [...group].sort((left, right) => {
      const textLengthDelta = runtime.normalizeDuplicateTranslationText(right && right.translated_text).length - runtime.normalizeDuplicateTranslationText(left && left.translated_text).length;
      if (textLengthDelta !== 0) {
        return textLengthDelta;
      }
      const leftBox = runtime.getPercentBubbleBox(left);
      const rightBox = runtime.getPercentBubbleBox(right);
      return (rightBox ? rightBox.width * rightBox.height : 0) - (leftBox ? leftBox.width * leftBox.height : 0);
    })[0];
    const mergedFillBox = runtime.mergePercentFillBoxes(group);
    return {
      ...preferred,
      x: runtime.clamp(box.left, 0, 100),
      y: runtime.clamp(box.top, 0, 100),
      w: runtime.clamp(box.width, 0.1, 100),
      h: runtime.clamp(box.height, 0.1, 100),
      fill_box: mergedFillBox || preferred.fill_box || null,
      original_text: preferred.original_text,
      translated_text: preferred.translated_text,
      source_line_count: Math.max(1, ...group.map(item => Number(item && item.source_line_count) || 1))
    };
  }
  runtime.mergeDuplicateTranslationBubbles = mergeDuplicateTranslationBubbles;
  function normalizeDuplicateTranslationText(text) {
    return String(text || "").replace(/\s+/g, "").replace(/[，。！？!?.,;；:："'“”‘’()\[\]（）【】]/g, "").trim();
  }
  runtime.normalizeDuplicateTranslationText = normalizeDuplicateTranslationText;
}
