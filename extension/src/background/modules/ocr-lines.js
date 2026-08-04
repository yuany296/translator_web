export function installOcrLines(runtime) {
  function isMeaningfulOcrText(text) {
    const raw = String(text || "").normalize("NFKC").trim();
    return !!raw && /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff\u3040-\u30ff\u3400-\u9fffA-Za-z0-9]/u.test(raw);
  }
  runtime.isMeaningfulOcrText = isMeaningfulOcrText;
  function hasMeaningfulKoreanOrCjkText(text) {
    return /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff\u3040-\u30ff\u3400-\u9fff]/u.test(String(text || ""));
  }
  runtime.hasMeaningfulKoreanOrCjkText = hasMeaningfulKoreanOrCjkText;
  function isReliableMeaningfulShortOcrText(text) {
    const raw = String(text || "").normalize("NFKC").trim();
    if (!runtime.isMeaningfulOcrText(raw)) {
      return false;
    }
    if (/[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff\u3040-\u30ff]/u.test(raw)) {
      return true;
    }
    if (/[\u3400-\u9fff]/u.test(raw)) {
      return !/[?？�]/u.test(raw);
    }
    return false;
  }
  runtime.isReliableMeaningfulShortOcrText = isReliableMeaningfulShortOcrText;
  function isLikelyMojibakeShortOcrText(text) {
    const raw = String(text || "").normalize("NFKC").trim();
    return Array.from(raw).length <= 4 && /[\u3400-\u9fff]/u.test(raw) && !/[\uac00-\ud7af\u3040-\u30ff]/u.test(raw) && /[?\uFFFD]/u.test(raw);
  }
  runtime.isLikelyMojibakeShortOcrText = isLikelyMojibakeShortOcrText;
  function localPaddleBoxIou(left, right) {
    const overlapWidth = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
    const overlapHeight = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    const intersection = overlapWidth * overlapHeight;
    const union = left.width * left.height + right.width * right.height - intersection;
    return intersection / Math.max(1, union);
  }
  runtime.localPaddleBoxIou = localPaddleBoxIou;
  function getLocalPaddleProjectedBounds(entry, rotation) {
    if (!entry || !entry.box) return null;
    const sources = Array.isArray(entry.entries) && entry.entries.length > 0 ? entry.entries : [entry];
    const points = sources.flatMap(source => Array.isArray(source.item && source.item.polygon) ? source.item.polygon : []).map(point => ({
      x: Number(Array.isArray(point) ? point[0] : point && point.x),
      y: Number(Array.isArray(point) ? point[1] : point && point.y)
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length < 4) {
      const box = entry.box;
      points.push({ x: box.left, y: box.top }, { x: box.right, y: box.top }, { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom });
    }
    const projected = points.map(point => runtime.projectPointForReadingOrder(point.x, point.y, rotation));
    const left = Math.min(...projected.map(point => point.inline));
    const right = Math.max(...projected.map(point => point.inline));
    const top = Math.min(...projected.map(point => point.line));
    const bottom = Math.max(...projected.map(point => point.line));
    return {
      left,
      right,
      top,
      bottom,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      centerX: (left + right) / 2,
      centerY: (top + bottom) / 2
    };
  }
  runtime.getLocalPaddleProjectedBounds = getLocalPaddleProjectedBounds;
  function getLocalPaddlePairGeometry(left, right) {
    const rotation = runtime.medianRotation([left && left.rotation, right && right.rotation]);
    const leftBox = runtime.getLocalPaddleProjectedBounds(left, rotation);
    const rightBox = runtime.getLocalPaddleProjectedBounds(right, rotation);
    if (!leftBox || !rightBox) return null;
    const gap = (firstStart, firstEnd, secondStart, secondEnd) => firstStart > secondEnd ? firstStart - secondEnd : secondStart > firstEnd ? secondStart - firstEnd : 0;
    return {
      rotation,
      left: leftBox,
      right: rightBox,
      inlineGap: gap(leftBox.left, leftBox.right, rightBox.left, rightBox.right),
      lineGap: gap(leftBox.top, leftBox.bottom, rightBox.top, rightBox.bottom),
      inlineOverlap: Math.max(0, Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left)),
      lineOverlap: Math.max(0, Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top))
    };
  }
  runtime.getLocalPaddlePairGeometry = getLocalPaddlePairGeometry;
  function compareLocalPaddleReadingOrder(left, right) {
    const pair = runtime.getLocalPaddlePairGeometry(left, right);
    if (!pair) return 0;
    const lineDelta = pair.left.centerY - pair.right.centerY;
    const tolerance = Math.max(pair.left.height, pair.right.height) * 0.55;
    return Math.abs(lineDelta) > tolerance ? lineDelta : pair.left.centerX - pair.right.centerX;
  }
  runtime.compareLocalPaddleReadingOrder = compareLocalPaddleReadingOrder;
  function buildLocalPaddleLineGroups(entries) {
    return runtime.buildConnectedLocalPaddleGroups(entries, runtime.shouldMergeLocalPaddleSameLine).map(runtime.buildLocalPaddleLineGroup).sort(runtime.compareLocalPaddleReadingOrder);
  }
  runtime.buildLocalPaddleLineGroups = buildLocalPaddleLineGroups;
  function buildConnectedLocalPaddleGroups(items, predicate) {
    const groups = [];
    const visited = new Set();
    items.forEach((item, index) => {
      if (visited.has(index)) {
        return;
      }
      const group = [];
      const queue = [index];
      visited.add(index);
      while (queue.length > 0) {
        const currentIndex = queue.shift();
        const current = items[currentIndex];
        group.push(current);
        items.forEach((candidate, candidateIndex) => {
          if (!visited.has(candidateIndex) && predicate(current, candidate)) {
            visited.add(candidateIndex);
            queue.push(candidateIndex);
          }
        });
      }
      groups.push(group);
    });
    return groups;
  }
  runtime.buildConnectedLocalPaddleGroups = buildConnectedLocalPaddleGroups;
  function localPaddleNodeEntries(value) {
    return Array.isArray(value?.entries) && value.entries.length ? value.entries : value ? [value] : [];
  }
  runtime.localPaddleNodeEntries = localPaddleNodeEntries;
  function areUnifiedLocalPaddleSpeechBubbleContainers(left, right) {
    if (!left || !right || !left.box || !right.box) return false;
    if (String(left.id || "") && left.id === right.id) return true;
    if ([left, right].some(container => String(container.type || "").toLowerCase() !== "speech_bubble" || Number(container.confidence || 0) < 0.75)) return false;
    const overlapWidth = Math.max(0, Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left));
    const overlapHeight = Math.max(0, Math.min(left.box.bottom, right.box.bottom) - Math.max(left.box.top, right.box.top));
    const widthRatio = overlapWidth / Math.max(1, Math.min(left.box.width, right.box.width));
    const heightRatio = overlapHeight / Math.max(1, Math.min(left.box.height, right.box.height));
    const overlapAreaRatio = overlapWidth * overlapHeight / Math.max(1, Math.min(left.box.width * left.box.height, right.box.width * right.box.height));
    return Math.max(widthRatio, heightRatio) >= 0.8 && Math.min(widthRatio, heightRatio) >= 0.35 && overlapAreaRatio >= 0.35 && runtime.getLocalPaddleRegionColorDistance(left.color, right.color) <= 24;
  }
  runtime.areUnifiedLocalPaddleSpeechBubbleContainers = areUnifiedLocalPaddleSpeechBubbleContainers;
  function shareUnifiedSpeechBubbleContainer(...values) {
    const entries = values.flatMap(runtime.localPaddleNodeEntries).filter(Boolean);
    if (entries.length < 2 || entries.some(entry => runtime.normalizeChatTranslationRole(entry.translationRole || entry.translation_role || entry.item?.translation_role))) return false;
    const containers = entries.map(entry => entry.container).filter(Boolean);
    if (containers.length !== entries.length || containers.some(container => String(container.type || "").toLowerCase() !== "speech_bubble")) return false;
    if (containers.some(container => !String(container.id || ""))) return false;
    const connected = new Set([0]);
    for (const index of connected) containers.forEach((container, candidate) => {
      if (runtime.areUnifiedLocalPaddleSpeechBubbleContainers(containers[index], container)) connected.add(candidate);
    });
    return connected.size === containers.length;
  }
  runtime.shareUnifiedSpeechBubbleContainer = shareUnifiedSpeechBubbleContainer;
  function shouldMergeLocalPaddleSameLine(left, right) {
    if (!left || !right || runtime.rotationDistance(left.rotation, right.rotation) > 18) {
      return false;
    }
    if (!runtime.areLocalPaddleRegionsCompatible(left, right) || !runtime.areLocalPaddleScriptsCompatible(left.text, right.text)) {
      return false;
    }
    const geometry = runtime.getLocalPaddlePairGeometry(left, right);
    if (!geometry) return false;
    const sharedSpeechBubble = runtime.shareUnifiedSpeechBubbleContainer(left, right);
    const heightRatio = Math.min(geometry.left.height, geometry.right.height) / Math.max(geometry.left.height, geometry.right.height);
    if (heightRatio < 0.65 && !sharedSpeechBubble) {
      return false;
    }

    // Chat/UI rejection: time format mismatch — don't merge timestamp with message body
    const leftTime = runtime.CHAT_TIME_RE.test(left.text);
    const rightTime = runtime.CHAT_TIME_RE.test(right.text);
    if (leftTime !== rightTime) return false;

    // Chat/UI rejection: height ratio too extreme for same-line merging (title/body)
    if (heightRatio < 1 / runtime.CHAT_MERGE_HEIGHT_RATIO_MAX && !sharedSpeechBubble) return false;

    // Chat/UI rejection: color brightness difference (only when both have color data)
    const lColor = left && left.color;
    const rColor = right && right.color;
    if (lColor && rColor && typeof lColor.brightness === "number" && typeof rColor.brightness === "number" && lColor.selected > 0 && rColor.selected > 0) {
      if (Math.abs(lColor.brightness - rColor.brightness) > runtime.CHAT_MERGE_BRIGHTNESS_DIFF && !sharedSpeechBubble) return false;
    }
    const avgHeight = Math.max(1, (geometry.left.height + geometry.right.height) / 2);
    const baselineDistance = Math.abs(geometry.left.bottom - geometry.right.bottom);
    return geometry.lineOverlap >= Math.min(geometry.left.height, geometry.right.height) * 0.5 && baselineDistance <= avgHeight * 0.35 && geometry.inlineGap < avgHeight * 1.2;
  }
  runtime.shouldMergeLocalPaddleSameLine = shouldMergeLocalPaddleSameLine;
  function buildLocalPaddleLineGroup(entries) {
    const sorted = [...entries].sort(runtime.compareLocalPaddleReadingOrder);
    const box = sorted.map(entry => entry.box).reduce(runtime.unionLocalPaddleBoxes);
    return {
      entries: sorted,
      box,
      text: sorted.map(entry => String(entry.item && entry.item.words || entry.text || "").trim()).filter(Boolean).join(" "),
      rotation: runtime.medianRotation(sorted.map(entry => entry.rotation)),
      confidence: Math.max(...sorted.map(entry => Number(entry.item && entry.item.confidence) || 0))
    };
  }
  runtime.buildLocalPaddleLineGroup = buildLocalPaddleLineGroup;
  function buildLocalPaddleParagraphGroups(lines) {
    return runtime.buildConnectedLocalPaddleGroups(lines, runtime.shouldMergeLocalPaddleParagraphLines).flatMap(runtime.splitLocalPaddleParagraphGroup);
  }
  runtime.buildLocalPaddleParagraphGroups = buildLocalPaddleParagraphGroups;
  function splitLocalPaddleParagraphGroup(group) {
    const sorted = [...group].sort(runtime.compareLocalPaddleReadingOrder);
    if (sorted.length < 4) {
      return [sorted];
    }
    for (let index = 2; index < sorted.length - 1; index += 1) {
      if (!runtime.isLocalPaddleParagraphBoundary(sorted[index - 1], sorted[index])) {
        continue;
      }
      return [...runtime.splitLocalPaddleParagraphGroup(sorted.slice(0, index)), ...runtime.splitLocalPaddleParagraphGroup(sorted.slice(index))];
    }
    return [sorted];
  }
  runtime.splitLocalPaddleParagraphGroup = splitLocalPaddleParagraphGroup;
  function isLocalPaddleParagraphBoundary(left, right) {
    if (!left || !right || !left.box || !right.box) {
      return false;
    }
    const geometry = runtime.getLocalPaddlePairGeometry(left, right);
    if (!geometry) return false;
    const avgHeight = Math.max(1, (geometry.left.height + geometry.right.height) / 2);
    const overlapRatio = geometry.inlineOverlap / Math.max(1, Math.min(geometry.left.width, geometry.right.width));
    const centerOffset = Math.abs(geometry.left.centerX - geometry.right.centerX);
    const widthRatio = Math.min(geometry.left.width, geometry.right.width) / Math.max(geometry.left.width, geometry.right.width);
    const largeBlankBreak = geometry.lineGap >= avgHeight * 1.1;
    const shiftedLayoutBreak = geometry.lineGap >= avgHeight * 0.65 && centerOffset >= avgHeight * 2.5 && widthRatio < 0.62 && overlapRatio < 0.68;
    return largeBlankBreak || shiftedLayoutBreak;
  }
  runtime.isLocalPaddleParagraphBoundary = isLocalPaddleParagraphBoundary;
  function shouldMergeLocalPaddleParagraphLines(left, right) {
    const rotationDelta = left && right ? runtime.rotationDistance(left.rotation, right.rotation) : Infinity;
    if (!left || !right || rotationDelta > 18) {
      return false;
    }
    if (!runtime.areLocalPaddleLineRegionsCompatible(left, right) || !runtime.areLocalPaddleScriptsCompatible(left.text, right.text)) {
      return false;
    }
    const geometry = runtime.getLocalPaddlePairGeometry(left, right);
    if (!geometry) return false;
    const sharedSpeechBubble = runtime.shareUnifiedSpeechBubbleContainer(left, right);
    const heightRatio = Math.min(geometry.left.height, geometry.right.height) / Math.max(geometry.left.height, geometry.right.height);
    if (heightRatio < 0.65 && !sharedSpeechBubble) {
      return false;
    }

    // Chat pattern rejection: small text above large text (e.g., username above message body)
    // When the upper box is significantly smaller, vertically close, and horizontally overlapping
    if (!sharedSpeechBubble && rotationDelta < 3.5 && heightRatio < 1 / runtime.CHAT_PARAGRAPH_HEIGHT_RATIO_MAX) {
      const chatAvgHeight = Math.max(1, (geometry.left.height + geometry.right.height) / 2);
      const upperAboveLower = geometry.left.centerY < geometry.right.centerY;
      const chatOverlapRatio = geometry.inlineOverlap / Math.max(1, Math.min(geometry.left.width, geometry.right.width));
      if (upperAboveLower && geometry.lineGap < chatAvgHeight * runtime.CHAT_SMALL_ABOVE_LARGE_MIN_GAP && chatOverlapRatio > 0.3) {
        return false;
      }
    }
    const avgHeight = Math.max(1, (geometry.left.height + geometry.right.height) / 2);
    const verticalGap = geometry.lineGap;
    const hasChatTimestamp = runtime.CHAT_TIME_RE.test(String(left.text || "")) || runtime.CHAT_TIME_RE.test(String(right.text || ""));
    const chatMetaGap = geometry.inlineGap;
    if (hasChatTimestamp && heightRatio >= 0.75 && verticalGap <= avgHeight * 0.35 && chatMetaGap <= avgHeight * 2.4) {
      return true;
    }
    if (verticalGap >= avgHeight * 1.2) {
      return false;
    }
    const overlapRatio = geometry.inlineOverlap / Math.max(1, Math.min(geometry.left.width, geometry.right.width));
    const centerOffset = Math.abs(geometry.left.centerX - geometry.right.centerX);
    // 气泡边缘常有斜体手写补充语。只有方向变化、超过两个行高的中心偏移和局部重叠同时出现时才拆分，
    // 这些比例在同一区域的 owner / 相邻页 OCR 中保持稳定，也能避免把普通短句或整段倾斜误拆。
    const hasEdgeLetteringStyleBreak = rotationDelta >= 3.5 && centerOffset > avgHeight * 2 && overlapRatio < 0.65;
    if (hasEdgeLetteringStyleBreak) {
      return false;
    }
    const centerClose = centerOffset <= Math.max(geometry.left.width, geometry.right.width) * 0.35;
    if (!centerClose && overlapRatio <= 0.35) {
      return false;
    }
    const widthRatio = Math.min(geometry.left.width, geometry.right.width) / Math.max(geometry.left.width, geometry.right.width);
    const leftAligned = Math.abs(geometry.left.left - geometry.right.left) <= avgHeight * 2.2;
    const rightAligned = Math.abs(geometry.left.right - geometry.right.right) <= avgHeight * 2.2;
    return widthRatio >= 0.35 || leftAligned || rightAligned || centerClose;
  }
  runtime.shouldMergeLocalPaddleParagraphLines = shouldMergeLocalPaddleParagraphLines;
  function areLocalPaddleRegionsCompatible(left, right) {
    const leftContainer = left && left.container;
    const rightContainer = right && right.container;
    if (!leftContainer || !rightContainer) {
      return true;
    }
    if (leftContainer.id === rightContainer.id) {
      return true;
    }
    if (runtime.areUnifiedLocalPaddleSpeechBubbleContainers(leftContainer, rightContainer)) {
      return true;
    }
    if (leftContainer.type === "caption_panel" && rightContainer.type === "caption_panel") {
      return true;
    }
    return runtime.areNestedLocalPaddleRegionFragments(left, right);
  }
  runtime.areLocalPaddleRegionsCompatible = areLocalPaddleRegionsCompatible;
  function areNestedLocalPaddleRegionFragments(left, right) {
    const leftContainer = left && left.container;
    const rightContainer = right && right.container;
    if (!leftContainer || !rightContainer || !leftContainer.box || !rightContainer.box) {
      return false;
    }
    const leftType = String(leftContainer.type || "").toLowerCase();
    const rightType = String(rightContainer.type || "").toLowerCase();
    const isCaptionSpeechPair = leftType === "caption_panel" && rightType === "speech_bubble" || leftType === "speech_bubble" && rightType === "caption_panel";
    if (!isCaptionSpeechPair) {
      return false;
    }
    if (Number(leftContainer.confidence || 0) < 0.75 || Number(rightContainer.confidence || 0) < 0.75) {
      return false;
    }
    if (runtime.rotationDistance(left.rotation, right.rotation) > 4) {
      return false;
    }
    const leftBox = left.box;
    const rightBox = right.box;
    const avgHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
    const heightRatio = Math.min(leftBox.height, rightBox.height) / Math.max(leftBox.height, rightBox.height);
    const verticalOverlap = Math.max(0, Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top));
    if (heightRatio < 0.78 || verticalOverlap < Math.min(leftBox.height, rightBox.height) * 0.7 || Math.abs(leftBox.bottom - rightBox.bottom) > avgHeight * 0.25 || runtime.getHorizontalGap(leftBox, rightBox) > avgHeight * 0.35) {
      return false;
    }
    const leftRegion = leftContainer.box;
    const rightRegion = rightContainer.box;
    const overlapWidth = Math.max(0, Math.min(leftRegion.right, rightRegion.right) - Math.max(leftRegion.left, rightRegion.left));
    const overlapHeight = Math.max(0, Math.min(leftRegion.bottom, rightRegion.bottom) - Math.max(leftRegion.top, rightRegion.top));
    const overlapArea = overlapWidth * overlapHeight;
    const leftArea = Math.max(1, leftRegion.width * leftRegion.height);
    const rightArea = Math.max(1, rightRegion.width * rightRegion.height);
    const smallerArea = Math.min(leftArea, rightArea);
    const largerArea = Math.max(leftArea, rightArea);
    if (overlapArea / smallerArea < 0.85 || smallerArea / largerArea > 0.55) {
      return false;
    }
    return runtime.getLocalPaddleRegionColorDistance(leftContainer.color, rightContainer.color) <= 24;
  }
  runtime.areNestedLocalPaddleRegionFragments = areNestedLocalPaddleRegionFragments;
  function getLocalPaddleRegionColorDistance(left, right) {
    const parse = value => {
      const match = String(value || "").trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (!match) {
        return null;
      }
      const hex = match[1].length === 3 ? Array.from(match[1], char => char + char).join("") : match[1];
      return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
    };
    const leftRgb = parse(left);
    const rightRgb = parse(right);
    if (!leftRgb || !rightRgb) {
      return Infinity;
    }
    return Math.hypot(leftRgb[0] - rightRgb[0], leftRgb[1] - rightRgb[1], leftRgb[2] - rightRgb[2]);
  }
  runtime.getLocalPaddleRegionColorDistance = getLocalPaddleRegionColorDistance;
  function areLocalPaddleLineRegionsCompatible(left, right) {
    return left.entries.some(leftEntry => right.entries.some(rightEntry => runtime.areLocalPaddleRegionsCompatible(leftEntry, rightEntry)));
  }
  runtime.areLocalPaddleLineRegionsCompatible = areLocalPaddleLineRegionsCompatible;
  function areLocalPaddleScriptsCompatible(leftText, rightText) {
    const leftHangul = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/.test(leftText);
    const rightHangul = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/.test(rightText);
    const leftHan = /[\u3400-\u9fff]/.test(leftText);
    const rightHan = /[\u3400-\u9fff]/.test(rightText);
    return !(leftHangul && rightHan && !rightHangul || rightHangul && leftHan && !leftHangul);
  }

  /**
   * Auto-detect chat/forum region type from a group of OCR entries.
   * Returns "chat" if the entries exhibit chat-like patterns (timestamps,
   * small-above-large stacking, left alignment, regular arrangement), or null.
   */
  runtime.areLocalPaddleScriptsCompatible = areLocalPaddleScriptsCompatible;
}
