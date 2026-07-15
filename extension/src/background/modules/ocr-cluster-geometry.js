export function installOcrClusterGeometry(runtime) {
  function buildLocalPaddleConnectedClusters(entries, imageSize) {
    const clusters = [];
    const visited = new Set();
    for (let index = 0; index < entries.length; index += 1) {
      if (visited.has(index)) {
        continue;
      }
      const cluster = [];
      const queue = [index];
      visited.add(index);
      while (queue.length > 0) {
        const current = queue.shift();
        const entry = entries[current];
        cluster.push(entry);
        for (let otherIndex = 0; otherIndex < entries.length; otherIndex += 1) {
          if (visited.has(otherIndex)) {
            continue;
          }
          if (runtime.shouldJoinLocalPaddleCluster(entry, entries[otherIndex], imageSize)) {
            visited.add(otherIndex);
            queue.push(otherIndex);
          }
        }
      }
      clusters.push(cluster);
    }
    return clusters;
  }
  runtime.buildLocalPaddleConnectedClusters = buildLocalPaddleConnectedClusters;
  function shouldJoinLocalPaddleCluster(left, right, imageSize) {
    if (!left || !right) {
      return false;
    }
    // 不把不同方向、但空间上恰好相交的拟声词拼成一句。
    if (runtime.rotationDistance(left.rotation, right.rotation) > 18) {
      return false;
    }
    if (runtime.shouldJoinLocalPaddleCaptionText(left, right)) {
      return true;
    }
    if (left.kind !== right.kind) {
      return false;
    }
    if (left.kind === "bubbleText") {
      if (!left.container || !right.container || left.container.id !== right.container.id) {
        return false;
      }
      return runtime.shouldJoinLocalPaddleBubbleText(left.box, right.box);
    }
    if (left.kind === "effectText") {
      return runtime.shouldJoinLocalPaddleEffectText(left, right, imageSize);
    }
    return runtime.shouldJoinLocalPaddleNormalOutsideText(left, right, imageSize);
  }
  runtime.shouldJoinLocalPaddleCluster = shouldJoinLocalPaddleCluster;
  function shouldJoinLocalPaddleCaptionText(left, right) {
    const leftCaption = runtime.isLocalPaddleCaptionEntry(left);
    const rightCaption = runtime.isLocalPaddleCaptionEntry(right);
    if (!leftCaption && !rightCaption) {
      return false;
    }
    // 语音气泡仍按各自区域隔离；这里仅修正被纯色背景检测切碎的说明面板。
    if (left.container && !leftCaption || right.container && !rightCaption) {
      return false;
    }
    const leftBox = left.box;
    const rightBox = right.box;
    const avgHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
    const verticalOverlap = Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top);
    const sameLine = verticalOverlap >= Math.min(leftBox.height, rightBox.height) * 0.45;
    if (sameLine) {
      return runtime.getHorizontalGap(leftBox, rightBox) <= avgHeight * 1.25;
    }
    const verticalGap = runtime.getVerticalGap(leftBox, rightBox);
    const overlapX = Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
    const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(leftBox.width, rightBox.width)) : 0;
    const rightEdgeDistance = Math.abs(leftBox.right - rightBox.right);
    return verticalGap <= avgHeight * 0.95 && (overlapRatio >= 0.12 || rightEdgeDistance <= avgHeight * 1.6);
  }
  runtime.shouldJoinLocalPaddleCaptionText = shouldJoinLocalPaddleCaptionText;
  function isLocalPaddleCaptionEntry(entry) {
    return Boolean(entry && entry.container && entry.container.type === "caption_panel");
  }
  runtime.isLocalPaddleCaptionEntry = isLocalPaddleCaptionEntry;
  function shouldJoinLocalPaddleBubbleText(leftBox, rightBox) {
    const avgHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
    const avgWidth = Math.max(1, (leftBox.width + rightBox.width) / 2);
    const verticalOverlap = Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top);
    const sameLine = verticalOverlap >= Math.min(leftBox.height, rightBox.height) * 0.45;
    const horizontalGap = runtime.getHorizontalGap(leftBox, rightBox);
    if (sameLine) {
      return horizontalGap <= avgHeight * 2.2;
    }
    const verticalGap = runtime.getVerticalGap(leftBox, rightBox);
    if (runtime.isLocalPaddleVerticalPair(leftBox, rightBox)) {
      return verticalGap <= Math.max(avgHeight, avgWidth) * 1.45;
    }
    const centerDistance = Math.abs(leftBox.centerX - rightBox.centerX);
    const indent = Math.abs(leftBox.left - rightBox.left);
    const overlapX = Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
    const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(leftBox.width, rightBox.width)) : 0;
    return verticalGap <= avgHeight * runtime.LOCAL_OCR_BUBBLE_JOIN_GAP_RATIO && (centerDistance <= Math.max(leftBox.width, rightBox.width) * 0.52 || indent <= avgHeight * 2.6 || overlapRatio >= 0.2);
  }
  runtime.shouldJoinLocalPaddleBubbleText = shouldJoinLocalPaddleBubbleText;
  function shouldJoinLocalPaddleEffectText(left, right, imageSize) {
    const leftBox = left.box;
    const rightBox = right.box;
    const avgHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
    const maxWidth = Math.max(leftBox.width, rightBox.width);
    const horizontalGap = runtime.getHorizontalGap(leftBox, rightBox);
    const verticalGap = runtime.getVerticalGap(leftBox, rightBox);
    const centerDistance = Math.hypot(leftBox.centerX - rightBox.centerX, leftBox.centerY - rightBox.centerY);
    const unionLeft = Math.min(leftBox.left, rightBox.left);
    const unionRight = Math.max(leftBox.right, rightBox.right);
    const unionTop = Math.min(leftBox.top, rightBox.top);
    const unionBottom = Math.max(leftBox.bottom, rightBox.bottom);
    const unionWidth = unionRight - unionLeft;
    const unionHeight = unionBottom - unionTop;
    const overlapX = Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
    const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(leftBox.width, rightBox.width)) : 0;
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const leftRedScore = Number(left.color && left.color.redScore) || 0;
    const rightRedScore = Number(right.color && right.color.redScore) || 0;
    const colorClose = Math.abs(leftRedScore - rightRedScore) <= 0.48;
    if (!colorClose) {
      return false;
    }
    if (unionWidth > Math.min(imageWidth * 0.5, maxWidth * 1.7 + avgHeight * 2.2)) {
      return false;
    }
    if (centerDistance > Math.max(maxWidth * 0.95, avgHeight * 5.2)) {
      return false;
    }
    if (verticalGap > avgHeight * 0.75 && overlapRatio < 0.2) {
      return false;
    }
    return horizontalGap <= avgHeight * runtime.LOCAL_OCR_EFFECT_JOIN_DISTANCE_RATIO && verticalGap <= avgHeight * 1.45 && unionHeight <= avgHeight * 4.8;
  }
  runtime.shouldJoinLocalPaddleEffectText = shouldJoinLocalPaddleEffectText;
  function shouldJoinLocalPaddleNormalOutsideText(left, right, imageSize) {
    const leftBox = left.box;
    const rightBox = right.box;
    const avgHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const verticalOverlap = Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top);
    const sameLine = verticalOverlap >= Math.min(leftBox.height, rightBox.height) * 0.45;
    if (sameLine) {
      return runtime.getHorizontalGap(leftBox, rightBox) <= avgHeight * 1.2;
    }
    const verticalGap = runtime.getVerticalGap(leftBox, rightBox);
    const centerDistance = Math.abs(leftBox.centerX - rightBox.centerX);
    const overlapX = Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
    const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(leftBox.width, rightBox.width)) : 0;
    const unionWidth = Math.max(leftBox.right, rightBox.right) - Math.min(leftBox.left, rightBox.left);
    const unionHeight = Math.max(leftBox.bottom, rightBox.bottom) - Math.min(leftBox.top, rightBox.top);
    const leftText = String(left.text || "");
    const rightText = String(right.text || "");
    const hasHangul = /[\uac00-\ud7af]/.test(leftText + rightText);
    const redScore = Math.max(Number(left.color && left.color.redScore) || 0, Number(right.color && right.color.redScore) || 0);
    if (verticalGap <= avgHeight * 0.9 && centerDistance <= Math.max(leftBox.width, rightBox.width) * 0.42) {
      return true;
    }

    // Kakao-style large speech bubbles sometimes fail white-container detection.
    // Treat aligned black Hangul lines as one bubble block instead of translating
    // every OCR line separately.
    return hasHangul && redScore < 0.12 && verticalGap <= avgHeight * 1.45 && unionWidth <= imageWidth * 0.72 && unionHeight <= avgHeight * 6.2 && (centerDistance <= Math.max(leftBox.width, rightBox.width) * 0.72 || overlapRatio >= 0.18);
  }
  runtime.shouldJoinLocalPaddleNormalOutsideText = shouldJoinLocalPaddleNormalOutsideText;
  function isLocalPaddleVerticalPair(leftBox, rightBox) {
    const avgWidth = Math.max(1, (leftBox.width + rightBox.width) / 2);
    const leftTall = leftBox.height >= leftBox.width * 1.1;
    const rightTall = rightBox.height >= rightBox.width * 1.1;
    return leftTall && rightTall && Math.abs(leftBox.centerX - rightBox.centerX) <= avgWidth * 1.35;
  }
  runtime.isLocalPaddleVerticalPair = isLocalPaddleVerticalPair;
  function mergeLocalPaddleCluster(cluster, imageSize, imageAnalysis, regionType = "") {
    if (!Array.isArray(cluster) || cluster.length === 0) {
      return null;
    }
    const items = cluster.map(entry => entry.item);
    const merged = runtime.mergeBaiduWordItems(items, imageSize);
    if (!merged) {
      return null;
    }
    const sharedRotation = Number(cluster.sharedRotation);
    const geometry = runtime.buildRotatedClusterGeometry(cluster, imageSize, Number.isFinite(sharedRotation) ? sharedRotation : null);
    if (geometry) {
      merged.polygon = geometry.polygon;
      merged.rotation_deg = geometry.rotation;
      merged.sourceLineCount = geometry.lineCount;
      merged.words = runtime.composeRotatedClusterWords(cluster, geometry.rotation);
    } else {
      const rotation = runtime.medianRotation(cluster.map(entry => entry.rotation));
      merged.rotation_deg = rotation;
      merged.sourceLineCount = runtime.estimateRotatedClusterLineCount(cluster, rotation);
      merged.words = runtime.composeRotatedClusterWords(cluster, rotation);
    }
    const fontRotation = geometry ? geometry.rotation : runtime.medianRotation(cluster.map(entry => entry.rotation));
    const fontHeights = cluster.map(entry => Number(entry && entry.item && entry.item.line_thickness) || runtime.getProjectedPolygonLineThickness(entry && entry.item && entry.item.polygon, fontRotation) || Math.min(Number(entry && entry.box && entry.box.width) || 0, Number(entry && entry.box && entry.box.height) || 0)).filter(height => height > 0).sort((left, right) => left - right);
    merged.fontHeight = fontHeights.length > 0 ? fontHeights[Math.floor(fontHeights.length / 2)] : 0;
    const captionEntries = cluster.filter(runtime.isLocalPaddleCaptionEntry);
    const representative = captionEntries[0] || cluster[0];
    const colorRepresentative = runtime.chooseLocalPaddleColorRepresentative(captionEntries.length > 0 ? captionEntries : cluster) || representative;
    const representativeContainer = representative.container || null;
    const containerIds = new Set(cluster.map(entry => entry.container && entry.container.id).filter(Boolean));
    const hasSingleCompleteContainer = containerIds.size === 1 && cluster.every(entry => entry.container);
    const displayBox = runtime.buildLocalPaddleDisplayBox(cluster, hasSingleCompleteContainer ? representativeContainer.box : null, imageSize, regionType || (representativeContainer ? representativeContainer.type : ""), representativeContainer ? representativeContainer.confidence : 0, geometry);
    if (displayBox) {
      merged.location = displayBox;
      merged.rawBox = displayBox;
    }
    merged.localOcrClusterKind = representativeContainer ? "bubbleText" : representative.kind;
    merged.localOcrContainerId = hasSingleCompleteContainer ? representativeContainer.id : "";
    merged.localOcrRegionType = regionType || (representativeContainer ? representativeContainer.type : "effect_text");
    merged.alignment = runtime.inferLocalPaddleClusterAlignment(cluster, imageSize, merged.localOcrRegionType);
    const translationRole = runtime.inferLocalPaddleClusterTranslationRole(cluster, merged.localOcrRegionType);
    const fontWeight = runtime.inferLocalPaddleClusterFontWeight(cluster, translationRole, merged.localOcrRegionType);
    if (translationRole) {
      merged.translationRole = translationRole;
      merged.translation_role = translationRole;
    }
    if (fontWeight > 0) {
      merged.fontWeight = fontWeight;
      merged.font_weight = fontWeight;
    }
    merged.regionPolygon = hasSingleCompleteContainer ? representativeContainer.polygon : null;
    merged.regionBox = hasSingleCompleteContainer ? representativeContainer.box : null;
    merged.region_confidence = hasSingleCompleteContainer ? Number(representativeContainer.confidence) || 0 : 0;
    merged.textColor = colorRepresentative.textColor || "";
    merged.strokeColor = colorRepresentative.strokeColor || "";
    merged.adaptiveBackground = representativeContainer && representativeContainer.color ? {
      type: "solid",
      color: representativeContainer.color,
      confidence: representativeContainer.confidence
    } : {
      type: "outline",
      color: "",
      confidence: 0
    };
    merged.nonTranslate = cluster.nonTranslate === true && !runtime.normalizeChatTranslationRole(translationRole);
    merged.memberRegionIds = [...new Set(cluster.flatMap(entry => Array.isArray(entry && entry.item && entry.item.member_region_ids) ? entry.item.member_region_ids : [entry && entry.item && entry.item.region_id]).map(String).filter(Boolean))];
    merged.detectedRegions = cluster.map(entry => entry && entry.item && entry.item.detected_region).filter(Boolean);
    return merged;
  }
  runtime.mergeLocalPaddleCluster = mergeLocalPaddleCluster;
  function chooseLocalPaddleColorRepresentative(entries) {
    const colors = (Array.isArray(entries) ? entries : []).map(entry => ({
      entry,
      rgb: runtime.parseLocalPaddleHexColor(entry && entry.textColor),
      weight: Math.max(0.1, Number(entry && entry.item && entry.item.confidence) || 0.5) * Math.max(1, runtime.normalizeTextForLocalPaddle(entry && entry.text).length)
    })).filter(item => item.rgb);
    if (colors.length === 0) {
      return null;
    }
    const groups = [];
    colors.forEach(color => {
      const group = groups.find(candidate => candidate.some(item => runtime.localPaddleRgbDistance(item.rgb, color.rgb) <= 72));
      if (group) group.push(color);else groups.push([color]);
    });
    const dominant = groups.sort((left, right) => right.reduce((sum, item) => sum + item.weight, 0) - left.reduce((sum, item) => sum + item.weight, 0))[0];
    return dominant.sort((left, right) => {
      const leftDistance = dominant.reduce((sum, item) => sum + runtime.localPaddleRgbDistance(left.rgb, item.rgb) * item.weight, 0);
      const rightDistance = dominant.reduce((sum, item) => sum + runtime.localPaddleRgbDistance(right.rgb, item.rgb) * item.weight, 0);
      return leftDistance - rightDistance || right.weight - left.weight;
    })[0].entry;
  }
  runtime.chooseLocalPaddleColorRepresentative = chooseLocalPaddleColorRepresentative;
  function parseLocalPaddleHexColor(value) {
    const match = String(value || "").trim().match(/^#([0-9a-f]{6})$/i);
    if (!match) return null;
    return [0, 2, 4].map(offset => Number.parseInt(match[1].slice(offset, offset + 2), 16));
  }
  runtime.parseLocalPaddleHexColor = parseLocalPaddleHexColor;
  function localPaddleRgbDistance(left, right) {
    return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
  }
  runtime.localPaddleRgbDistance = localPaddleRgbDistance;
  function inferLocalPaddleClusterTranslationRole(cluster, regionType = "") {
    const explicit = runtime.normalizeChatTranslationRole(cluster && cluster.translationRole);
    if (explicit) {
      return explicit;
    }
    const entries = Array.isArray(cluster) ? cluster : [];
    const roles = entries.map(entry => runtime.normalizeChatTranslationRole(entry && (entry.translationRole || entry.translation_role || entry.item && (entry.item.translation_role || entry.item.translationRole)))).filter(Boolean);
    if (roles.length > 0) {
      return roles[0];
    }
    if (runtime.isChatRegionType(regionType)) {
      return runtime.inferLocalPaddleChatClusterRole(entries, entries);
    }
    return "";
  }
  runtime.inferLocalPaddleClusterTranslationRole = inferLocalPaddleClusterTranslationRole;
  function inferLocalPaddleClusterFontWeight(cluster, translationRole = "", regionType = "") {
    const roleWeight = runtime.getChatRoleFontWeight(translationRole);
    if (roleWeight > 0) {
      return roleWeight;
    }
    const entryWeights = (Array.isArray(cluster) ? cluster : []).map(entry => runtime.normalizeOcrFontWeight(entry && (entry.fontWeight || entry.font_weight || entry.item && (entry.item.font_weight || entry.item.fontWeight)))).filter(weight => weight > 0).sort((left, right) => left - right);
    if (entryWeights.length > 0) {
      return entryWeights[Math.floor(entryWeights.length / 2)];
    }
    return runtime.isChatRegionType(regionType) ? runtime.CHAT_FONT_WEIGHTS.chat_body : 0;
  }
  runtime.inferLocalPaddleClusterFontWeight = inferLocalPaddleClusterFontWeight;
}
