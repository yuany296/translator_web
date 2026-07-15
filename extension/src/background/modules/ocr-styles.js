export function installOcrStyles(runtime) {
  /**
   * Keep visually different text layers as independent render candidates.
   * A paragraph may be spatially connected while still containing a username,
   * timestamp, heading, or message body with a different font size.
   */
  function splitLocalPaddleVisualStyleClusters(cluster, regionType = "") {
    if (!Array.isArray(cluster) || cluster.length < 2) {
      return [cluster];
    }
    const entries = cluster.filter(entry => entry && entry.box && entry.box.height > 0);
    if (entries.length < 2) {
      return [cluster];
    }
    if (runtime.isChatRegionType(regionType)) {
      const chatClusters = runtime.splitLocalPaddleChatRoleClusters(entries);
      if (chatClusters.length > 0) {
        return chatClusters;
      }
    }
    const heights = entries.map(entry => Number(entry.box.height)).sort((left, right) => left - right);
    const minHeight = heights[0];
    const maxHeight = heights[heights.length - 1];
    const heightRatio = maxHeight / Math.max(1, minHeight);
    if (heightRatio < runtime.OCR_STYLE_SPLIT_HEIGHT_RATIO) {
      return [cluster];
    }
    const hasTimestamp = entries.some(entry => runtime.CHAT_TIME_RE.test(String(entry.text || "")));
    const hasStackedStylePair = entries.some(left => entries.some(right => {
      if (left === right) return false;
      const small = left.box.height <= right.box.height ? left : right;
      const large = small === left ? right : left;
      const upper = small.box.top <= large.box.top ? small : large;
      const lower = upper === small ? large : small;
      const overlapX = Math.max(0, Math.min(small.box.right, large.box.right) - Math.max(small.box.left, large.box.left));
      const overlapRatio = overlapX / Math.max(1, Math.min(small.box.width, large.box.width));
      const gap = runtime.getVerticalGap(small.box, large.box);
      return upper === small && gap <= Math.max(small.box.height, large.box.height) * 0.65 && overlapRatio >= 0.3;
    }));

    // A reliable container already describes one comic bubble. Only split it
    // when the size difference is extreme; chat/UI text has no such container.
    const hasSharedContainer = entries.every(entry => entry.container && entry.container.id) && new Set(entries.map(entry => entry.container.id)).size === 1;
    if (hasSharedContainer && heightRatio < 1.7 && !hasTimestamp) {
      return [cluster];
    }
    if (!hasTimestamp && !hasStackedStylePair && String(regionType || "") !== "chat") {
      return [cluster];
    }

    // Find the strongest height gap and split around its geometric midpoint.
    let splitIndex = -1;
    let strongestGap = 1;
    for (let index = 1; index < heights.length; index += 1) {
      const gap = heights[index] / Math.max(1, heights[index - 1]);
      if (gap > strongestGap) {
        strongestGap = gap;
        splitIndex = index;
      }
    }
    if (splitIndex <= 0 || splitIndex >= heights.length) {
      return [cluster];
    }
    const threshold = Math.sqrt(heights[splitIndex - 1] * heights[splitIndex]);
    const small = cluster.filter(entry => Number(entry && entry.box && entry.box.height) <= threshold);
    const large = cluster.filter(entry => Number(entry && entry.box && entry.box.height) > threshold);
    return small.length > 0 && large.length > 0 ? [small, large] : [cluster];
  }
  runtime.splitLocalPaddleVisualStyleClusters = splitLocalPaddleVisualStyleClusters;
  function splitLocalPaddleChatRoleClusters(entries) {
    const usable = (Array.isArray(entries) ? entries : []).filter(entry => entry && entry.box && String(entry.text || entry.item && entry.item.words || "").trim()).sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left);
    if (usable.length === 0) {
      return [];
    }
    const groups = [];
    usable.forEach(entry => {
      const role = runtime.inferLocalPaddleChatEntryRole(entry, usable);
      const withRole = runtime.withLocalPaddleChatRole(entry, role);
      const group = groups.find(candidate => candidate.translationRole === role && runtime.shouldJoinLocalPaddleChatRoleGroup(candidate, withRole, role));
      if (group) {
        group.push(withRole);
      } else {
        const next = [withRole];
        next.translationRole = role;
        next.fontWeight = runtime.getChatRoleFontWeight(role);
        groups.push(next);
      }
    });
    return groups.map(group => {
      group.translationRole = runtime.normalizeChatTranslationRole(group.translationRole) || runtime.inferLocalPaddleChatClusterRole(group, usable);
      group.fontWeight = runtime.getChatRoleFontWeight(group.translationRole);
      group.nonTranslate = false;
      return group;
    });
  }
  runtime.splitLocalPaddleChatRoleClusters = splitLocalPaddleChatRoleClusters;
  function getSeamCandidateVisualContributionBox(candidate, imageSize, maxCrossHeight) {
    if (String(candidate && candidate.bg_type || "").trim().toLowerCase() !== "solid") {
      return null;
    }
    const regionType = String(candidate && candidate.region_type || "").trim().toLowerCase();
    if (regionType !== "speech_bubble" && regionType !== "caption_panel") {
      return null;
    }
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const textBox = runtime.getSeamCandidateRawBox(candidate, imageSize);
    const visualBoxes = [runtime.percentPolygonToObservationPixelBox(candidate && candidate.region_polygon, imageSize), runtime.percentBoxToObservationPixelBox(candidate && candidate.fill_box, imageSize)].filter(Boolean);
    for (const visualBox of visualBoxes) {
      const overlapsText = Boolean(textBox && runtime.intersectObservationBoxes(textBox, visualBox));
      const bounded = visualBox.width <= imageWidth * runtime.SEAM_CROSS_MAX_VISUAL_WIDTH_COVERAGE && visualBox.height <= maxCrossHeight && visualBox.width * visualBox.height <= imageWidth * imageHeight * runtime.SEAM_CROSS_MAX_VISUAL_AREA_COVERAGE;
      if (overlapsText && bounded) {
        return visualBox;
      }
    }
    return null;
  }
  runtime.getSeamCandidateVisualContributionBox = getSeamCandidateVisualContributionBox;
  function percentBoxToObservationPixelBox(value, imageSize) {
    if (!value || typeof value !== "object") return null;
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const x = Number(value.x ?? value.left);
    const y = Number(value.y ?? value.top);
    const width = Number(value.w ?? value.width);
    const height = Number(value.h ?? value.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    const left = runtime.clamp(x, 0, 100) / 100 * imageWidth;
    const top = runtime.clamp(y, 0, 100) / 100 * imageHeight;
    const right = runtime.clamp(x + width, 0, 100) / 100 * imageWidth;
    const bottom = runtime.clamp(y + height, 0, 100) / 100 * imageHeight;
    return right > left && bottom > top ? {
      left,
      top,
      width: right - left,
      height: bottom - top
    } : null;
  }
  runtime.percentBoxToObservationPixelBox = percentBoxToObservationPixelBox;
  function percentPolygonToObservationPixelBox(value, imageSize) {
    if (!Array.isArray(value) || value.length < 3) return null;
    const points = value.map(point => ({
      x: Number(Array.isArray(point) ? point[0] : point && point.x),
      y: Number(Array.isArray(point) ? point[1] : point && point.y)
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length < 3) return null;
    const left = Math.min(...points.map(point => point.x));
    const top = Math.min(...points.map(point => point.y));
    const right = Math.max(...points.map(point => point.x));
    const bottom = Math.max(...points.map(point => point.y));
    return runtime.percentBoxToObservationPixelBox({
      x: left,
      y: top,
      w: right - left,
      h: bottom - top
    }, imageSize);
  }
  runtime.percentPolygonToObservationPixelBox = percentPolygonToObservationPixelBox;
  function unionObservationBoxes(left, right) {
    if (!left) return right || null;
    if (!right) return left;
    const boxLeft = Math.min(left.left, right.left);
    const boxTop = Math.min(left.top, right.top);
    const boxRight = Math.max(left.left + left.width, right.left + right.width);
    const boxBottom = Math.max(left.top + left.height, right.top + right.height);
    return {
      left: boxLeft,
      top: boxTop,
      width: boxRight - boxLeft,
      height: boxBottom - boxTop
    };
  }
  runtime.unionObservationBoxes = unionObservationBoxes;
  function inferLocalPaddleChatEntryRole(entry, entries) {
    const explicit = runtime.normalizeChatTranslationRole(entry && (entry.translationRole || entry.translation_role || entry.item && (entry.item.translation_role || entry.item.translationRole)));
    if (explicit) {
      return explicit;
    }
    const text = String(entry && (entry.item && entry.item.words || entry.text) || "");
    if (runtime.isChatTimeText(text)) {
      return runtime.CHAT_TRANSLATION_ROLES.time;
    }
    const boxes = (Array.isArray(entries) ? entries : []).map(item => item && item.box).filter(Boolean);
    const heights = boxes.map(box => Number(box.height) || 0).filter(height => height > 0);
    const maxHeight = Math.max(1, ...heights);
    const height = Math.max(1, Number(entry && entry.box && entry.box.height) || 1);
    const timePeers = (Array.isArray(entries) ? entries : []).filter(item => item !== entry && runtime.isChatTimeText(item && (item.item && item.item.words || item.text)));
    const sameLineTime = timePeers.find(item => runtime.areLocalPaddleBoxesOnSameVisualLine(entry.box, item.box));
    if (sameLineTime && entry.box.centerX <= sameLineTime.box.centerX) {
      return runtime.CHAT_TRANSLATION_ROLES.nickname;
    }
    if (height >= maxHeight * 0.72) {
      return runtime.CHAT_TRANSLATION_ROLES.body;
    }
    const hasLargeBelow = (Array.isArray(entries) ? entries : []).some(item => item !== entry && item.box && item.box.height >= height * runtime.OCR_STYLE_SPLIT_HEIGHT_RATIO && item.box.top >= entry.box.top && runtime.getVerticalGap(entry.box, item.box) <= item.box.height * 1.25);
    return hasLargeBelow ? runtime.CHAT_TRANSLATION_ROLES.aux : runtime.CHAT_TRANSLATION_ROLES.nickname;
  }
  runtime.inferLocalPaddleChatEntryRole = inferLocalPaddleChatEntryRole;
  function inferLocalPaddleChatClusterRole(cluster, allEntries) {
    const roles = (Array.isArray(cluster) ? cluster : []).map(entry => runtime.inferLocalPaddleChatEntryRole(entry, allEntries)).filter(Boolean);
    return roles[0] || runtime.CHAT_TRANSLATION_ROLES.body;
  }
  runtime.inferLocalPaddleChatClusterRole = inferLocalPaddleChatClusterRole;
  function areLocalPaddleBoxesOnSameVisualLine(left, right) {
    if (!left || !right) {
      return false;
    }
    const overlap = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
    return overlap >= Math.min(left.height, right.height) * 0.45;
  }
  runtime.areLocalPaddleBoxesOnSameVisualLine = areLocalPaddleBoxesOnSameVisualLine;
  function shouldJoinLocalPaddleChatRoleGroup(group, entry, role) {
    if (!Array.isArray(group) || group.length === 0 || !entry || !entry.box) {
      return false;
    }
    if (role === runtime.CHAT_TRANSLATION_ROLES.time) {
      return false;
    }
    const groupBox = group.map(item => item.box).reduce(runtime.unionLocalPaddleBoxes);
    const box = entry.box;
    const avgHeight = Math.max(1, (groupBox.height + box.height) / 2);
    if (runtime.areLocalPaddleBoxesOnSameVisualLine(groupBox, box)) {
      return runtime.getHorizontalGap(groupBox, box) <= avgHeight * 2.4;
    }
    if (role !== runtime.CHAT_TRANSLATION_ROLES.body) {
      return false;
    }
    const verticalGap = runtime.getVerticalGap(groupBox, box);
    const leftAligned = Math.abs(groupBox.left - box.left) <= avgHeight * 1.35;
    const overlapX = Math.max(0, Math.min(groupBox.right, box.right) - Math.max(groupBox.left, box.left));
    const overlapRatio = overlapX / Math.max(1, Math.min(groupBox.width, box.width));
    return verticalGap <= avgHeight * 0.85 && (leftAligned || overlapRatio >= 0.35);
  }
  runtime.shouldJoinLocalPaddleChatRoleGroup = shouldJoinLocalPaddleChatRoleGroup;
  function dedupeLocalPaddleEntries(entries) {
    const kept = [];
    const duplicates = [];
    [...entries].sort((left, right) => runtime.getLocalPaddleEntryQuality(right) - runtime.getLocalPaddleEntryQuality(left)).forEach(entry => {
      const duplicate = kept.find(candidate => runtime.areDuplicateLocalPaddleEntries(entry, candidate));
      if (duplicate) {
        duplicates.push({
          entry,
          kept: duplicate
        });
      } else {
        kept.push(entry);
      }
    });
    return {
      entries: kept.sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left),
      duplicates
    };
  }
  runtime.dedupeLocalPaddleEntries = dedupeLocalPaddleEntries;
  function areDuplicateLocalPaddleEntries(left, right) {
    if (!left || !right || !left.box || !right.box) {
      return false;
    }
    const similarity = runtime.normalizedTextSimilarity(left.text, right.text);
    if (similarity < 0.82) {
      return runtime.areConflictingLocalPaddleEntries(left, right);
    }
    const iou = runtime.localPaddleBoxIou(left.box, right.box);
    if (iou > 0.5) {
      return true;
    }
    const avgHeight = Math.max(1, (left.box.height + right.box.height) / 2);
    const heightRatio = Math.min(left.box.height, right.box.height) / Math.max(left.box.height, right.box.height);
    const centerDistance = Math.hypot(left.box.centerX - right.box.centerX, left.box.centerY - right.box.centerY);
    return similarity >= 0.88 && heightRatio >= 0.72 && centerDistance <= avgHeight * 0.55;
  }
  runtime.areDuplicateLocalPaddleEntries = areDuplicateLocalPaddleEntries;
  function areConflictingLocalPaddleEntries(left, right) {
    if (!left || !right || !left.box || !right.box) {
      return false;
    }
    const leftRegion = String(left.item && left.item.region_id || "");
    const rightRegion = String(right.item && right.item.region_id || "");
    if (leftRegion && rightRegion && leftRegion !== rightRegion) {
      return false;
    }
    const leftText = runtime.normalizeTextForLocalPaddle(left.text);
    const rightText = runtime.normalizeTextForLocalPaddle(right.text);
    const lengthRatio = Math.min(leftText.length, rightText.length) / Math.max(1, Math.max(leftText.length, rightText.length));
    if (Math.min(leftText.length, rightText.length) < 2 || lengthRatio < 0.72) {
      return false;
    }
    const leftConfidence = Number(left.item && left.item.confidence) || 0;
    const rightConfidence = Number(right.item && right.item.confidence) || 0;
    if (Math.abs(leftConfidence - rightConfidence) < 0.12 || Math.abs(left.rotation - right.rotation) > 4) {
      return false;
    }
    const horizontalOverlap = Math.max(0, Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left)) / Math.max(1, Math.min(left.box.width, right.box.width));
    const heightRatio = Math.min(left.box.height, right.box.height) / Math.max(left.box.height, right.box.height);
    const centerYDistance = Math.abs(left.box.centerY - right.box.centerY);
    const avgHeight = Math.max(1, (left.box.height + right.box.height) / 2);
    const overlapOverSmaller = runtime.localPaddleIntersectionArea(left.box, right.box) / Math.max(1, Math.min(left.box.width * left.box.height, right.box.width * right.box.height));
    return overlapOverSmaller >= 0.5 && horizontalOverlap >= 0.85 && heightRatio >= 0.65 && centerYDistance <= avgHeight * 0.85;
  }
  runtime.areConflictingLocalPaddleEntries = areConflictingLocalPaddleEntries;
  function localPaddleIntersectionArea(left, right) {
    return Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left)) * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  }
  runtime.localPaddleIntersectionArea = localPaddleIntersectionArea;
  function getLocalPaddleEntryQuality(entry) {
    const confidence = Number(entry && entry.item && entry.item.confidence) || 0;
    const completeness = runtime.normalizeTextForLocalPaddle(entry && entry.text).length;
    const area = entry && entry.box ? entry.box.width * entry.box.height : 0;
    return confidence * 1000000 + completeness * 1000 + Math.min(area, 999);
  }
  runtime.getLocalPaddleEntryQuality = getLocalPaddleEntryQuality;
  function normalizedTextSimilarity(left, right) {
    const first = runtime.normalizeTextForLocalPaddle(left);
    const second = runtime.normalizeTextForLocalPaddle(right);
    if (first === second) {
      return first ? 1 : 0;
    }
    if (!first || !second) {
      return 0;
    }
    let previous = Array.from({
      length: second.length + 1
    }, (_, index) => index);
    for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
      const current = [firstIndex];
      for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
        current.push(Math.min(current[secondIndex - 1] + 1, previous[secondIndex] + 1, previous[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1)));
      }
      previous = current;
    }
    return 1 - previous[previous.length - 1] / Math.max(first.length, second.length);
  }
  runtime.normalizedTextSimilarity = normalizedTextSimilarity;
  function normalizeTextForLocalPaddle(value) {
    return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }
  runtime.normalizeTextForLocalPaddle = normalizeTextForLocalPaddle;
}
