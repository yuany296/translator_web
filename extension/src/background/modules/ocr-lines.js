export function installOcrLines(runtime) {
  function isMeaningfulOcrText(text) {
    const raw = String(text || "").normalize("NFKC").trim();
    return !!raw && /[\uac00-\ud7af\u3130-\u318f\u3040-\u30ff\u3400-\u9fffA-Za-z0-9]/u.test(raw);
  }
  runtime.isMeaningfulOcrText = isMeaningfulOcrText;
  function hasMeaningfulKoreanOrCjkText(text) {
    return /[\uac00-\ud7af\u3040-\u30ff\u3400-\u9fff]/u.test(String(text || ""));
  }
  runtime.hasMeaningfulKoreanOrCjkText = hasMeaningfulKoreanOrCjkText;
  function isReliableMeaningfulShortOcrText(text) {
    const raw = String(text || "").normalize("NFKC").trim();
    if (!runtime.isMeaningfulOcrText(raw)) {
      return false;
    }
    if (/[\uac00-\ud7af\u3040-\u30ff]/u.test(raw)) {
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
  function buildLocalPaddleLineGroups(entries) {
    return runtime.buildConnectedLocalPaddleGroups(entries, runtime.shouldMergeLocalPaddleSameLine).map(runtime.buildLocalPaddleLineGroup).sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left);
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
  function shouldMergeLocalPaddleSameLine(left, right) {
    if (!left || !right || runtime.rotationDistance(left.rotation, right.rotation) > 18) {
      return false;
    }
    if (!runtime.areLocalPaddleRegionsCompatible(left, right) || !runtime.areLocalPaddleScriptsCompatible(left.text, right.text)) {
      return false;
    }
    const heightRatio = Math.min(left.box.height, right.box.height) / Math.max(left.box.height, right.box.height);
    if (heightRatio < 0.65) {
      return false;
    }

    // Chat/UI rejection: time format mismatch — don't merge timestamp with message body
    const leftTime = runtime.CHAT_TIME_RE.test(left.text);
    const rightTime = runtime.CHAT_TIME_RE.test(right.text);
    if (leftTime !== rightTime) return false;

    // Chat/UI rejection: height ratio too extreme for same-line merging (title/body)
    if (heightRatio < 1 / runtime.CHAT_MERGE_HEIGHT_RATIO_MAX) return false;

    // Chat/UI rejection: color brightness difference (only when both have color data)
    const lColor = left && left.color;
    const rColor = right && right.color;
    if (lColor && rColor && typeof lColor.brightness === "number" && typeof rColor.brightness === "number" && lColor.selected > 0 && rColor.selected > 0) {
      if (Math.abs(lColor.brightness - rColor.brightness) > runtime.CHAT_MERGE_BRIGHTNESS_DIFF) return false;
    }
    const avgHeight = Math.max(1, (left.box.height + right.box.height) / 2);
    const verticalOverlap = Math.min(left.box.bottom, right.box.bottom) - Math.max(left.box.top, right.box.top);
    const baselineDistance = Math.abs(left.box.bottom - right.box.bottom);
    return verticalOverlap >= Math.min(left.box.height, right.box.height) * 0.5 && baselineDistance <= avgHeight * 0.35 && runtime.getHorizontalGap(left.box, right.box) < avgHeight * 1.2;
  }
  runtime.shouldMergeLocalPaddleSameLine = shouldMergeLocalPaddleSameLine;
  function buildLocalPaddleLineGroup(entries) {
    const sorted = [...entries].sort((left, right) => left.box.left - right.box.left);
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
    const sorted = [...group].sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left);
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
    const avgHeight = Math.max(1, (left.box.height + right.box.height) / 2);
    const verticalGap = runtime.getVerticalGap(left.box, right.box);
    const overlapX = Math.max(0, Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left));
    const overlapRatio = overlapX / Math.max(1, Math.min(left.box.width, right.box.width));
    const centerOffset = Math.abs(left.box.centerX - right.box.centerX);
    const widthRatio = Math.min(left.box.width, right.box.width) / Math.max(left.box.width, right.box.width);
    const largeBlankBreak = verticalGap >= avgHeight * 1.1;
    const shiftedLayoutBreak = verticalGap >= avgHeight * 0.65 && centerOffset >= avgHeight * 2.5 && widthRatio < 0.62 && overlapRatio < 0.68;
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
    const heightRatio = Math.min(left.box.height, right.box.height) / Math.max(left.box.height, right.box.height);
    if (heightRatio < 0.65) {
      return false;
    }

    // Chat pattern rejection: small text above large text (e.g., username above message body)
    // When the upper box is significantly smaller, vertically close, and horizontally overlapping
    if (rotationDelta < 3.5 && heightRatio < 1 / runtime.CHAT_PARAGRAPH_HEIGHT_RATIO_MAX) {
      const chatAvgHeight = Math.max(1, (left.box.height + right.box.height) / 2);
      const upperAboveLower = left.box.top + left.box.bottom < right.box.top + right.box.bottom;
      const chatVerticalGap = runtime.getVerticalGap(left.box, right.box);
      const chatOverlapX = Math.max(0, Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left));
      const chatOverlapRatio = chatOverlapX / Math.max(1, Math.min(left.box.width, right.box.width));
      if (upperAboveLower && chatVerticalGap < chatAvgHeight * runtime.CHAT_SMALL_ABOVE_LARGE_MIN_GAP && chatOverlapRatio > 0.3) {
        return false;
      }
    }
    const avgHeight = Math.max(1, (left.box.height + right.box.height) / 2);
    const verticalGap = runtime.getVerticalGap(left.box, right.box);
    const hasChatTimestamp = runtime.CHAT_TIME_RE.test(String(left.text || "")) || runtime.CHAT_TIME_RE.test(String(right.text || ""));
    const chatMetaGap = Math.min(left.box.right, right.box.right) >= Math.max(left.box.left, right.box.left) ? 0 : runtime.getHorizontalGap(left.box, right.box);
    if (hasChatTimestamp && heightRatio >= 0.75 && verticalGap <= avgHeight * 0.35 && chatMetaGap <= avgHeight * 2.4) {
      return true;
    }
    if (verticalGap >= avgHeight * 1.2) {
      return false;
    }
    const overlapX = Math.max(0, Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left));
    const overlapRatio = overlapX / Math.max(1, Math.min(left.box.width, right.box.width));
    const centerOffset = Math.abs(left.box.centerX - right.box.centerX);
    // 气泡边缘常有斜体手写补充语。只有方向变化、超过两个行高的中心偏移和局部重叠同时出现时才拆分，
    // 这些比例在同一区域的 owner / 相邻页 OCR 中保持稳定，也能避免把普通短句或整段倾斜误拆。
    const hasEdgeLetteringStyleBreak = rotationDelta >= 3.5 && centerOffset > avgHeight * 2 && overlapRatio < 0.65;
    if (hasEdgeLetteringStyleBreak) {
      return false;
    }
    const centerClose = centerOffset <= Math.max(left.box.width, right.box.width) * 0.35;
    if (!centerClose && overlapRatio <= 0.35) {
      return false;
    }
    const widthRatio = Math.min(left.box.width, right.box.width) / Math.max(left.box.width, right.box.width);
    const leftAligned = Math.abs(left.box.left - right.box.left) <= avgHeight * 2.2;
    const rightAligned = Math.abs(left.box.right - right.box.right) <= avgHeight * 2.2;
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
    const leftHangul = /[\uac00-\ud7af]/.test(leftText);
    const rightHangul = /[\uac00-\ud7af]/.test(rightText);
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
