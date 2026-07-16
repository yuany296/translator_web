export function installOcrDisplayGeometry(runtime) {
  function buildLocalPaddleDisplayBox(cluster, regionBox, imageSize, regionType = "", geometry = null) {
    const boxes = (Array.isArray(cluster) ? cluster : []).map(entry => entry && entry.box).filter(Boolean);
    if (boxes.length === 0) {
      return null;
    }
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const union = boxes.reduce(runtime.unionLocalPaddleBoxes);
    const avgHeight = Math.max(1, boxes.reduce((sum, box) => sum + box.height, 0) / boxes.length);
    if (geometry && Math.abs(Number(geometry.rotation) || 0) >= 3 && geometry.inlineWidth > 0 && geometry.normalHeight > 0) {
      const lineThicknesses = cluster.map(entry => runtime.getProjectedPolygonLineThickness(entry && entry.item && entry.item.polygon, geometry.rotation)).filter(value => value > 0).sort((left, right) => left - right);
      const medianThickness = lineThicknesses[Math.floor(lineThicknesses.length / 2)] || avgHeight;
      const compact = runtime.isChatRegionType(regionType);
      const width = Math.min(imageWidth, geometry.inlineWidth + (compact ? 0 : Math.min(geometry.inlineWidth * 0.04, medianThickness * 0.5)));
      const height = Math.min(imageHeight, geometry.normalHeight + (compact ? 0 : Math.min(geometry.normalHeight * 0.06, medianThickness * 0.24)));
      const left = runtime.clamp(geometry.centerX - width / 2, 0, Math.max(0, imageWidth - width));
      const top = runtime.clamp(geometry.centerY - height / 2, 0, Math.max(0, imageHeight - height));
      return {
        left,
        top,
        width,
        height
      };
    }
    // 蓝框只围绕最终文字并集保留小幅留边；气泡区域只用于边界约束和背景判断。
    const compact = runtime.isChatRegionType(regionType);
    const marginX = compact ? 0 : Math.max(2, Math.min(union.width * 0.035, avgHeight * 0.25));
    const marginY = compact ? 0 : Math.max(2, Math.min(union.height * 0.04, avgHeight * 0.15));
    let left = Math.max(0, union.left - marginX);
    let top = Math.max(0, union.top - marginY);
    let right = Math.min(imageWidth, union.right + marginX);
    let bottom = Math.min(imageHeight, union.bottom + marginY);
    if (regionBox) {
      left = Math.max(left, Number(regionBox.left) || 0);
      top = Math.max(top, Number(regionBox.top) || 0);
      right = Math.min(right, (Number(regionBox.left) || 0) + Math.max(0, Number(regionBox.width) || 0));
      bottom = Math.min(bottom, (Number(regionBox.top) || 0) + Math.max(0, Number(regionBox.height) || 0));
    }
    return right > left && bottom > top ? {
      left,
      top,
      width: right - left,
      height: bottom - top
    } : null;
  }
  runtime.buildLocalPaddleDisplayBox = buildLocalPaddleDisplayBox;
  function buildRotatedClusterGeometry(cluster, imageSize, preferredRotation = null) {
    const points = cluster.flatMap(entry => Array.isArray(entry.item && entry.item.polygon) ? entry.item.polygon : []);
    if (points.length < 4) {
      return null;
    }
    const angles = cluster.map(entry => runtime.normalizeRotationDegrees(entry.rotation)).filter(Number.isFinite).sort((left, right) => left - right);
    const rotation = preferredRotation !== null && preferredRotation !== undefined && Number.isFinite(Number(preferredRotation)) ? runtime.normalizeRotationDegrees(preferredRotation) : angles[Math.floor(angles.length / 2)] || 0;
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
      x: x * cos - y * sin,
      y: x * sin + y * cos
    });
    const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const polygon = [inverse(minX, minY), inverse(maxX, minY), inverse(maxX, maxY), inverse(minX, maxY)].map(point => ({
      x: runtime.clamp(point.x, 0, width),
      y: runtime.clamp(point.y, 0, height)
    }));
    const center = inverse((minX + maxX) / 2, (minY + maxY) / 2);
    return {
      polygon,
      rotation,
      lineCount: runtime.estimateRotatedClusterLineCount(cluster, rotation),
      inlineWidth: maxX - minX,
      normalHeight: maxY - minY,
      centerX: runtime.clamp(center.x, 0, width),
      centerY: runtime.clamp(center.y, 0, height)
    };
  }
  runtime.buildRotatedClusterGeometry = buildRotatedClusterGeometry;
  function projectClusterCenter(entry, rotation) {
    const point = runtime.projectPointForReadingOrder(entry.box.centerX, entry.box.centerY, rotation);
    const polygonThickness = runtime.getProjectedPolygonLineThickness(entry && entry.item && entry.item.polygon, rotation);
    return {
      x: point.inline,
      y: point.line,
      height: Math.max(1, polygonThickness || Math.min(entry.box.width, entry.box.height))
    };
  }
  runtime.projectClusterCenter = projectClusterCenter;
  function getProjectedPolygonLineThickness(polygon, rotation) {
    const points = (Array.isArray(polygon) ? polygon : []).map(value => ({
      x: Array.isArray(value) ? Number(value[0]) : Number(value && value.x),
      y: Array.isArray(value) ? Number(value[1]) : Number(value && value.y)
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length < 4) {
      return 0;
    }
    const positions = points.map(point => runtime.projectPointForReadingOrder(point.x, point.y, rotation).line);
    const thickness = Math.max(...positions) - Math.min(...positions);
    return Number.isFinite(thickness) && thickness > 0 ? thickness : 0;
  }
  runtime.getProjectedPolygonLineThickness = getProjectedPolygonLineThickness;
  function buildRotatedClusterRows(cluster, rotation) {
    const rows = [];
    cluster.forEach(entry => {
      const point = runtime.projectClusterCenter(entry, rotation);
      let row = rows.find(candidate => Math.abs(candidate.y - point.y) <= Math.max(candidate.height, point.height) * 0.7);
      if (!row) {
        row = {
          y: point.y,
          height: point.height,
          entries: []
        };
        rows.push(row);
      }
      row.entries.push({
        entry,
        point
      });
      row.y = row.entries.reduce((sum, item) => sum + item.point.y, 0) / row.entries.length;
      row.height = Math.max(row.height, point.height);
    });
    return runtime.orientProjectedRowsVisualTopFirst(rows.map(row => ({
      line: row.y,
      height: row.height,
      entries: row.entries.map(item => ({
        ...item,
        box: item.entry.box,
        point: {
          inline: item.point.x,
          line: item.point.y
        }
      }))
    }))).map(row => ({
      y: row.line,
      height: row.height,
      entries: row.entries.map(item => ({
        entry: item.entry,
        point: {
          x: item.point.inline,
          y: item.point.line
        }
      }))
    }));
  }
  runtime.buildRotatedClusterRows = buildRotatedClusterRows;
  function estimateRotatedClusterLineCount(cluster, rotation) {
    return Math.max(1, runtime.buildRotatedClusterRows(cluster, rotation).length);
  }
  runtime.estimateRotatedClusterLineCount = estimateRotatedClusterLineCount;
  function composeRotatedClusterWords(cluster, rotation) {
    return runtime.buildRotatedClusterRows(cluster, rotation).map(row => row.entries.sort((left, right) => left.point.x - right.point.x).map(item => String(item.entry.item && item.entry.item.words || item.entry.text || "").trim()).filter(Boolean).join(" ")).filter(Boolean).join("\n");
  }
  runtime.composeRotatedClusterWords = composeRotatedClusterWords;
  function getHorizontalGap(leftBox, rightBox) {
    return leftBox.left > rightBox.right ? leftBox.left - rightBox.right : rightBox.left > leftBox.right ? rightBox.left - leftBox.right : 0;
  }
  runtime.getHorizontalGap = getHorizontalGap;
  function getVerticalGap(leftBox, rightBox) {
    return leftBox.top > rightBox.bottom ? leftBox.top - rightBox.bottom : rightBox.top > leftBox.bottom ? rightBox.top - leftBox.bottom : 0;
  }
  runtime.getVerticalGap = getVerticalGap;
  function getBoxOverlapArea(leftBox, rightBox) {
    if (!leftBox || !rightBox) {
      return 0;
    }
    const width = Math.max(0, Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left));
    const height = Math.max(0, Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top));
    return width * height;
  }
  runtime.getBoxOverlapArea = getBoxOverlapArea;
  function prepareLocalPaddleWords(words, imageSize) {
    const usableWords = words.filter(item => !runtime.shouldDropLocalPaddleNoiseItem(item, imageSize));
    const {
      merged,
      usedIndexes
    } = runtime.mergeLocalPaddleVerticalWords(usableWords, imageSize);
    const remaining = usableWords.filter((item, index) => !usedIndexes.has(index) && !runtime.shouldDropUnmergedLocalPaddleFragment(item, imageSize));
    return [...remaining, ...merged].sort(runtime.compareBaiduWordItems);
  }
  runtime.prepareLocalPaddleWords = prepareLocalPaddleWords;
  function mergeLocalPaddleVerticalWords(words, imageSize) {
    const candidates = words.map((item, index) => ({
      item,
      index,
      box: runtime.getBaiduItemBox(item)
    })).filter(entry => entry.box && runtime.isLocalPaddleVerticalCandidate(entry.item, entry.box, imageSize)).sort((left, right) => left.box.left - right.box.left || left.box.top - right.box.top);
    const groups = [];
    candidates.forEach(entry => {
      const group = groups.find(candidate => runtime.shouldJoinLocalPaddleVerticalGroup(candidate, entry));
      if (group) {
        group.entries.push(entry);
        group.box = runtime.getBaiduGroupBox(group.entries.map(item => item.item));
        return;
      }
      groups.push({
        entries: [entry],
        box: entry.box
      });
    });
    const usedIndexes = new Set();
    const merged = [];
    groups.forEach(group => {
      const entries = group.entries.sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left);
      if (entries.length < 2) {
        return;
      }
      const text = entries.map(entry => String(entry.item.words || "").trim()).filter(Boolean).join("");
      if (runtime.countScriptChars(text) < 2) {
        return;
      }
      const boxes = entries.map(entry => entry.box).filter(Boolean);
      const left = Math.min(...boxes.map(box => box.left));
      const top = Math.min(...boxes.map(box => box.top));
      const right = Math.max(...boxes.map(box => box.right));
      const bottom = Math.max(...boxes.map(box => box.bottom));
      const location = runtime.expandBaiduMergedLocation({
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
      }, boxes, imageSize);
      entries.forEach(entry => usedIndexes.add(entry.index));
      merged.push({
        words: text,
        confidence: Math.max(...entries.map(entry => Number(entry.item.confidence || 0))),
        rawBox: location,
        location
      });
    });
    return {
      merged,
      usedIndexes
    };
  }
  runtime.mergeLocalPaddleVerticalWords = mergeLocalPaddleVerticalWords;
  function isLocalPaddleVerticalCandidate(item, box, imageSize) {
    const text = String(item && item.words ? item.words : "").replace(/\s+/g, "");
    if (!text || !/[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/.test(text)) {
      return false;
    }
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    return box.height >= box.width * 1.35 || box.width <= imageWidth * 0.075 && box.height >= box.width * 1.1;
  }
  runtime.isLocalPaddleVerticalCandidate = isLocalPaddleVerticalCandidate;
  function shouldJoinLocalPaddleVerticalGroup(group, entry) {
    const groupBox = group.box;
    const box = entry.box;
    if (!groupBox || !box) {
      return false;
    }
    const avgWidth = Math.max(1, (groupBox.width + box.width) / 2);
    const centerDistance = Math.abs(groupBox.centerX - box.centerX);
    const verticalGap = box.top > groupBox.bottom ? box.top - groupBox.bottom : groupBox.top > box.bottom ? groupBox.top - box.bottom : 0;
    const overlapX = Math.min(groupBox.right, box.right) - Math.max(groupBox.left, box.left);
    const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(groupBox.width, box.width)) : 0;
    return (centerDistance <= avgWidth * 1.35 || overlapRatio >= 0.18) && verticalGap <= avgWidth * 2.2;
  }
  runtime.shouldJoinLocalPaddleVerticalGroup = shouldJoinLocalPaddleVerticalGroup;
  function shouldDropLocalPaddleNoiseItem(item, imageSize) {
    const box = runtime.getBaiduItemBox(item);
    const text = String(item && item.words ? item.words : "").replace(/\s+/g, "");
    if (!box || !text) {
      return true;
    }
    if (runtime.isLikelyMojibakeShortOcrText(text)) {
      return true;
    }
    if (runtime.isReliableShortSpeechBubbleItem(item)) {
      return false;
    }
    if (runtime.shouldDropLowConfidenceLocalPaddleText(text, Number(item.confidence || 0))) {
      return true;
    }
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const areaRatio = box.width * box.height / Math.max(1, imageWidth * imageHeight);
    if (!runtime.isReliableMeaningfulShortOcrText(text) && runtime.countScriptChars(text) <= 1 && areaRatio < 0.003 && Number(item.confidence || 0) < 0.98) {
      return true;
    }
    return false;
  }
  runtime.shouldDropLocalPaddleNoiseItem = shouldDropLocalPaddleNoiseItem;
  function shouldDropLowConfidenceLocalPaddleText(text, confidence) {
    const raw = String(text || "").trim();
    const score = Number(confidence || 0);
    if (!raw || score >= 0.72) {
      return false;
    }
    const hangul = (raw.match(/[\uac00-\ud7af]/g) || []).length;
    const jamo = (raw.match(/[\u3130-\u318f]/g) || []).length;
    const latin = (raw.match(/[A-Za-z]/g) || []).length;
    const script = runtime.countScriptChars(raw);
    if (runtime.isReliableMeaningfulShortOcrText(raw) && score >= 0.45) {
      return false;
    }
    if (latin > 0 && script <= 3) {
      return true;
    }
    if (hangul <= 1 && jamo > 0) {
      return true;
    }
    if (hangul <= 2 && score < 0.5) {
      return true;
    }
    if (hangul <= 1 && score < 0.62) {
      return true;
    }
    return false;
  }
  runtime.shouldDropLowConfidenceLocalPaddleText = shouldDropLowConfidenceLocalPaddleText;
}
