export function installOcrClustering(runtime) {
  function clusterLocalPaddleWords(words, imageSize, imageAnalysis, debugEnabled = false, ocrDebug = null) {
    // 兼容直接调用聚类器的测试/诊断入口；生产链路显式分离布尔开关与可写会话对象。
    const legacyDebug = debugEnabled && typeof debugEnabled === "object" ? debugEnabled : null;
    const debugSession = ocrDebug && typeof ocrDebug === "object" ? ocrDebug : legacyDebug;
    const debugMode = debugEnabled === true || Boolean(legacyDebug);
    const rawEntries = words.map((item, index) => runtime.buildLocalPaddleClusterEntry(item, index, imageSize, imageAnalysis, debugMode)).filter(entry => entry && entry.kind !== "noise");
    // 独立的拉丁标志属于画面装饰，不进入蓝框、翻译或覆盖层；原始候选仍由
    // ocrDebug.rawItems 保留，因此调试红框不会丢失。
    const contentEntries = rawEntries.filter(entry => !runtime.isDecorativeLatinMarkEntry(entry, rawEntries) && !runtime.isLikelyLocalPaddleUiArtifactEntry(entry, rawEntries, imageSize));
    const expandedEntries = runtime.expandLocalPaddleChatTimeEntries(contentEntries);
    const dedupeResult = runtime.dedupeLocalPaddleEntries(expandedEntries);
    const entries = dedupeResult.entries;
    const lineGroups = runtime.buildLocalPaddleLineGroups(entries);
    const paragraphGroups = runtime.buildLocalPaddleParagraphGroups(lineGroups);
    const clusters = paragraphGroups.map(group => group.flatMap(line => line.entries));
    // Detect region types for each cluster (chat/forum vs comic bubble)
    const clusterRegionTypes = runtime.inferLocalPaddleClusterRegionTypes(clusters);
    const merged = clusters.flatMap((cluster, index) => {
      const regionType = clusterRegionTypes[index];
      const sharedRotation = runtime.getReliableSharedClusterRotation(cluster, regionType, clusters, clusterRegionTypes);
      return runtime.splitLocalPaddleVisualStyleClusters(cluster, regionType).map(styleCluster => {
        if (Number.isFinite(sharedRotation)) {
          styleCluster.sharedRotation = sharedRotation;
        }
        const item = runtime.mergeLocalPaddleCluster(styleCluster, imageSize, imageAnalysis, clusterRegionTypes[index]);
        if (item && clusterRegionTypes[index]) {
          item.region_type = clusterRegionTypes[index];
          // 分段后的聊天元数据和正文都必须共享 chat 语义，不能被原始
          // speech_bubble/effect_text 容器类型覆盖。
          item.localOcrRegionType = clusterRegionTypes[index];
        }
        return item;
      });
    }).filter(item => item && item.words && item.location).sort(runtime.compareBaiduWordItems);
    if (debugSession) {
      debugSession.dedupedItems = entries.map((entry, index) => runtime.toDebugOcrItem(entry.item, index, imageSize, "deduped"));
      debugSession.lineItems = lineGroups.map((line, index) => {
        const lineGeometry = runtime.buildRotatedClusterGeometry(line.entries, imageSize, line.rotation);
        return runtime.toDebugOcrItem({
          words: line.text,
          confidence: line.confidence,
          location: line.box,
          polygon: lineGeometry && lineGeometry.polygon ? lineGeometry.polygon : null,
          rotation_deg: line.rotation
        }, index, imageSize, "line");
      });
      debugSession.duplicateItems = dedupeResult.duplicates.map((duplicate, index) => ({
        ...runtime.toDebugOcrItem(duplicate.entry.item, index, imageSize, "duplicate"),
        duplicateOf: duplicate.kept.text,
        isDuplicate: true
      }));
    }
    if (debugMode) {
      console.debug("[MangaTranslator] Local OCR clustering:", {
        containers: [...new Map(entries.filter(entry => entry.container).map(entry => [entry.container.id, entry.container])).values()],
        entries: entries.map(entry => ({
          text: entry.text,
          kind: entry.kind,
          containerId: entry.container ? entry.container.id : "",
          color: entry.color,
          box: entry.box
        })),
        clusters: clusters.map(cluster => cluster.map(entry => entry.text)),
        orientedGroups: clusters.map((cluster, index) => {
          const type = clusterRegionTypes[index];
          const sharedRotation = Number.isFinite(runtime.getReliableSharedClusterRotation(cluster, type, clusters, clusterRegionTypes)) ? runtime.getReliableSharedClusterRotation(cluster, type, clusters, clusterRegionTypes) : null;
          const angleDeg = Number.isFinite(sharedRotation) ? sharedRotation : runtime.medianRotation(cluster.map(e => e.rotation));
          const geometry = runtime.buildRotatedClusterGeometry(cluster, imageSize, Number.isFinite(sharedRotation) ? sharedRotation : null);
          const localW = geometry ? geometry.inlineWidth : 0;
          const localH = geometry ? geometry.normalHeight : 0;
          const aabbBox = cluster.map(e => e.box).reduce(runtime.unionLocalPaddleBoxes);
          const worldW = aabbBox ? aabbBox.width : 0;
          const worldH = aabbBox ? aabbBox.height : 0;
          return {
            id: `group-${index}`,
            angleDeg: Number(angleDeg.toFixed(1)),
            memberCount: cluster.length,
            localWidth: Number(localW.toFixed(1)),
            localHeight: Number(localH.toFixed(1)),
            worldAabbWidth: Number(worldW.toFixed(1)),
            worldAabbHeight: Number(worldH.toFixed(1)),
            regionType: String(type || ""),
            textSamples: cluster.slice(0, 3).map(e => String(e.text || "").slice(0, 40))
          };
        })
      });
    }
    return merged;
  }
  runtime.clusterLocalPaddleWords = clusterLocalPaddleWords;
  function isLikelyLocalPaddleUiArtifactEntry(entry, allEntries, imageSize) {
    if (!entry || !entry.box || runtime.normalizeChatTranslationRole(entry.translationRole)) return false;
    const text = String(entry.item && entry.item.words || entry.text || "").normalize("NFKC").replace(/\s+/g, "");
    if (/^\d{1,3}$/.test(text)) return true;
    if (runtime.countScriptChars(text) !== 1 || Array.from(text).length > 2) return false;
    const confidence = Number(entry.item && entry.item.confidence) || 0;
    const container = entry.container;
    const region = container && container.box;
    if (confidence >= 0.72 || !container || !region) return false;
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const panelLike = region.width >= imageWidth * 0.45 && region.width * region.height >= imageWidth * imageHeight * 0.16;
    const footerLike = entry.box.centerY >= region.top + region.height * 0.72;
    if (!panelLike || !footerLike) return false;
    const peers = (Array.isArray(allEntries) ? allEntries : []).filter(candidate => candidate && candidate !== entry && candidate.container && candidate.container.id === container.id && candidate.box && runtime.countScriptChars(candidate.text) >= 4 && Number(candidate.item && candidate.item.confidence) >= 0.8);
    const peerBottom = peers.length > 0 ? Math.max(...peers.map(candidate => candidate.box.bottom)) : Infinity;
    return peers.length > 0 && entry.box.top - peerBottom >= entry.box.height * 0.72;
  }
  runtime.isLikelyLocalPaddleUiArtifactEntry = isLikelyLocalPaddleUiArtifactEntry;
  function getReliableSharedClusterRotation(cluster, regionType = "", allClusters = [], regionTypes = []) {
    if (!runtime.isChatRegionType(regionType)) {
      return null;
    }
    const currentBox = runtime.getLocalPaddleEntriesBox(cluster);
    const relatedEntries = (Array.isArray(allClusters) ? allClusters : []).filter((candidate, index) => runtime.isChatRegionType(regionTypes[index]) && runtime.areRelatedChatRotationClusters(currentBox, runtime.getLocalPaddleEntriesBox(candidate))).flat();
    const rotation = runtime.medianRotation((relatedEntries.length > 0 ? relatedEntries : cluster).map(entry => entry && entry.rotation));
    return Number.isFinite(rotation) && Math.abs(rotation) <= 25 ? rotation : 0;
  }
  runtime.getReliableSharedClusterRotation = getReliableSharedClusterRotation;
  function areRelatedChatRotationClusters(left, right) {
    if (!left || !right) return false;
    const overlapX = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
    const overlapY = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    const horizontalGap = runtime.getHorizontalGap(left, right);
    const verticalGap = runtime.getVerticalGap(left, right);
    const scale = Math.max(1, Math.max(left.height, right.height));
    return overlapX > 0 || overlapY > 0 || horizontalGap <= scale * 2.5 && verticalGap <= scale * 1.5;
  }
  runtime.areRelatedChatRotationClusters = areRelatedChatRotationClusters;
  function isDecorativeLatinMarkEntry(entry, allEntries) {
    if (!entry || entry.container || runtime.normalizeChatTranslationRole(entry.translationRole)) {
      return false;
    }
    const text = String(entry.item && entry.item.words || entry.text || "").normalize("NFKC").trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,11}$/.test(text)) {
      return false;
    }
    const box = entry.box;
    if (!box) {
      return false;
    }
    // 与时戳同排的拉丁词通常是聊天昵称，不能按商标过滤。
    return !(Array.isArray(allEntries) ? allEntries : []).some(candidate => {
      if (!candidate || candidate === entry || !candidate.box || !runtime.isChatTimeText(candidate.item && candidate.item.words || candidate.text)) {
        return false;
      }
      const avgHeight = Math.max(1, (box.height + candidate.box.height) / 2);
      const geometry = runtime.getLocalPaddlePairGeometry(entry, candidate);
      return runtime.areLocalPaddleEntriesOnSameVisualLine(entry, candidate) && geometry && geometry.inlineGap <= avgHeight * 3;
    });
  }
  runtime.isDecorativeLatinMarkEntry = isDecorativeLatinMarkEntry;
  function isChatRegionType(regionType) {
    const type = String(regionType || "").toLowerCase();
    return type === "chat" || type === "comment" || type === "ui";
  }
  runtime.isChatRegionType = isChatRegionType;
  function normalizeChatTranslationRole(value) {
    const text = String(value || "").trim();
    return runtime.CHAT_TRANSLATION_ROLE_RE.test(text) ? text : "";
  }
  runtime.normalizeChatTranslationRole = normalizeChatTranslationRole;
  function getChatRoleFontWeight(role) {
    return runtime.CHAT_FONT_WEIGHTS[runtime.normalizeChatTranslationRole(role)] || 0;
  }
  runtime.getChatRoleFontWeight = getChatRoleFontWeight;
  function normalizeOcrFontWeight(value) {
    const numeric = Math.round(Number(value) || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return 0;
    }
    return runtime.clamp(Math.round(numeric / 100) * 100, 100, 900);
  }
  runtime.normalizeOcrFontWeight = normalizeOcrFontWeight;
  function isChatOcrCandidate(candidate) {
    return !!candidate && (runtime.normalizeChatTranslationRole(candidate.translation_role || candidate.translationRole) || runtime.isChatRegionType(candidate.region_type || candidate.regionType));
  }
  runtime.isChatOcrCandidate = isChatOcrCandidate;
  function isLocalPaddleChatLikeCluster(entries) {
    const usable = (Array.isArray(entries) ? entries : []).filter(Boolean);
    if (usable.length < 2) {
      return false;
    }
    return usable.some(entry => runtime.normalizeChatTranslationRole(entry && (entry.translationRole || entry.translation_role || entry.item && (entry.item.translation_role || entry.item.translationRole))) || runtime.isChatTimeText(entry && (entry.item && entry.item.words || entry.text)));
  }
  runtime.isLocalPaddleChatLikeCluster = isLocalPaddleChatLikeCluster;
  function inferLocalPaddleClusterRegionTypes(clusters) {
    const items = (Array.isArray(clusters) ? clusters : []).map(cluster => ({
      cluster,
      box: runtime.getLocalPaddleEntriesBox(cluster),
      type: runtime.detectLocalPaddleRegionType(cluster) || (runtime.isLocalPaddleChatLikeCluster(cluster) ? "chat" : null)
    }));
    items.forEach((item, index) => {
      if (item.type || !item.box) {
        return;
      }
      const previous = items[index - 1];
      if (runtime.isLocalPaddleLikelyChatBodyCluster(item, previous)) {
        item.type = "chat";
      }
    });
    return items.map(item => item.type);
  }
  runtime.inferLocalPaddleClusterRegionTypes = inferLocalPaddleClusterRegionTypes;
  function getLocalPaddleEntriesBox(entries) {
    const boxes = (Array.isArray(entries) ? entries : []).map(entry => entry && entry.box).filter(Boolean);
    return boxes.length > 0 ? boxes.reduce(runtime.unionLocalPaddleBoxes) : null;
  }
  runtime.getLocalPaddleEntriesBox = getLocalPaddleEntriesBox;
  function isLocalPaddleLikelyChatBodyCluster(item, previous) {
    if (!item || !item.box || !previous || previous.type !== "chat" || !previous.box) {
      return false;
    }
    const currentEntry = {
      entries: item.cluster,
      box: item.box,
      rotation: runtime.medianRotation(item.cluster.map(entry => entry.rotation))
    };
    const previousEntry = {
      entries: previous.cluster,
      box: previous.box,
      rotation: runtime.medianRotation(previous.cluster.map(entry => entry.rotation))
    };
    const geometry = runtime.getLocalPaddlePairGeometry(previousEntry, currentEntry);
    if (!geometry) return false;
    const avgHeight = Math.max(1, (geometry.left.height + geometry.right.height) / 2);
    const overlapRatio = geometry.inlineOverlap / Math.max(1, Math.min(geometry.left.width, geometry.right.width));
    const leftAligned = Math.abs(geometry.left.left - geometry.right.left) <= avgHeight * 1.8;
    const lower = geometry.right.centerY >= geometry.left.centerY;
    const larger = geometry.right.height >= geometry.left.height * 1.25 || geometry.right.height >= avgHeight * 1.08;
    return lower && larger && geometry.lineGap <= avgHeight * 1.65 && (leftAligned || overlapRatio >= 0.2);
  }
  runtime.isLocalPaddleLikelyChatBodyCluster = isLocalPaddleLikelyChatBodyCluster;
  function isChatTimeText(text) {
    const raw = String(text || "").normalize("NFKC").trim();
    return !!raw && runtime.CHAT_TIME_RE.test(raw);
  }
  runtime.isChatTimeText = isChatTimeText;
  function expandLocalPaddleChatTimeEntries(entries) {
    return (Array.isArray(entries) ? entries : []).flatMap(entry => runtime.splitLocalPaddleChatTimeEntry(entry));
  }
  runtime.expandLocalPaddleChatTimeEntries = expandLocalPaddleChatTimeEntries;
  function splitLocalPaddleChatTimeEntry(entry) {
    if (!entry || !entry.box) {
      return [];
    }
    const sourceText = String(entry.item && entry.item.words || entry.text || "").normalize("NFKC").trim();
    const match = sourceText.match(runtime.CHAT_TIME_RE);
    if (!match || typeof match.index !== "number") {
      return [entry];
    }
    const start = match.index;
    const end = start + String(match[0] || "").length;
    const segments = [{
      text: sourceText.slice(0, start).trim(),
      start: 0,
      end: start,
      role: runtime.CHAT_TRANSLATION_ROLES.nickname
    }, {
      text: sourceText.slice(start, end).trim(),
      start,
      end,
      role: runtime.CHAT_TRANSLATION_ROLES.time
    }, {
      text: sourceText.slice(end).trim(),
      start: end,
      end: sourceText.length,
      role: runtime.CHAT_TRANSLATION_ROLES.aux
    }].filter(segment => segment.text);
    if (segments.length <= 1) {
      const role = runtime.isChatTimeText(sourceText) ? runtime.CHAT_TRANSLATION_ROLES.time : "";
      return role ? [runtime.withLocalPaddleChatRole(entry, role)] : [entry];
    }
    const totalLength = Math.max(1, sourceText.length);
    return segments.map(segment => runtime.cloneLocalPaddleEntrySegment(entry, segment, totalLength));
  }
  runtime.splitLocalPaddleChatTimeEntry = splitLocalPaddleChatTimeEntry;
  function withLocalPaddleChatRole(entry, role) {
    const normalizedRole = runtime.normalizeChatTranslationRole(role);
    if (!normalizedRole || !entry) {
      return entry;
    }
    const fontWeight = runtime.getChatRoleFontWeight(normalizedRole);
    return {
      ...entry,
      translationRole: normalizedRole,
      fontWeight,
      item: {
        ...(entry.item || {}),
        translation_role: normalizedRole,
        translationRole: normalizedRole,
        font_weight: fontWeight,
        fontWeight
      }
    };
  }
  runtime.withLocalPaddleChatRole = withLocalPaddleChatRole;
  function cloneLocalPaddleEntrySegment(entry, segment, totalLength) {
    const sourceBox = entry.box;
    const startRatio = runtime.clamp(Number(segment.start) / totalLength, 0, 1);
    const endRatio = runtime.clamp(Number(segment.end) / totalLength, startRatio, 1);
    const polygon = runtime.sliceLocalPaddlePolygonByInlineRatio(entry.item && entry.item.polygon, entry.rotation, startRatio, endRatio);
    const polygonBox = runtime.getLocalPaddlePolygonBox(polygon);
    const minWidth = Math.min(sourceBox.width, Math.max(1, sourceBox.height * 0.6));
    const left = sourceBox.left + sourceBox.width * startRatio;
    const right = Math.max(left + minWidth, sourceBox.left + sourceBox.width * endRatio);
    const box = polygonBox || runtime.buildBaiduBox(left, sourceBox.top, Math.min(sourceBox.right, right), sourceBox.bottom);
    const role = runtime.normalizeChatTranslationRole(segment.role);
    const fontWeight = runtime.getChatRoleFontWeight(role);
    const item = {
      ...(entry.item || {}),
      words: segment.text,
      location: {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height
      },
      rawBox: {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height
      },
      polygon,
      translation_role: role,
      translationRole: role,
      font_weight: fontWeight,
      fontWeight
    };
    return {
      ...entry,
      item,
      box,
      text: String(segment.text || "").replace(/\s+/g, ""),
      translationRole: role,
      fontWeight
    };
  }
  runtime.cloneLocalPaddleEntrySegment = cloneLocalPaddleEntrySegment;
  function sliceLocalPaddlePolygonByInlineRatio(polygon, rotation, startRatio, endRatio) {
    const points = (Array.isArray(polygon) ? polygon : []).map(point => ({
      x: Array.isArray(point) ? Number(point[0]) : Number(point && point.x),
      y: Array.isArray(point) ? Number(point[1]) : Number(point && point.y)
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length < 4) return null;
    const angle = runtime.normalizeRotationDegrees(rotation);
    const radians = angle * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const projected = points.map(point => ({
      inline: point.x * cos + point.y * sin,
      normal: -point.x * sin + point.y * cos
    }));
    const minInline = Math.min(...projected.map(point => point.inline));
    const maxInline = Math.max(...projected.map(point => point.inline));
    const minNormal = Math.min(...projected.map(point => point.normal));
    const maxNormal = Math.max(...projected.map(point => point.normal));
    const left = minInline + (maxInline - minInline) * startRatio;
    const right = minInline + (maxInline - minInline) * endRatio;
    const inverse = (inline, normal) => ({
      x: inline * cos - normal * sin,
      y: inline * sin + normal * cos
    });
    return [inverse(left, minNormal), inverse(right, minNormal), inverse(right, maxNormal), inverse(left, maxNormal)];
  }
  runtime.sliceLocalPaddlePolygonByInlineRatio = sliceLocalPaddlePolygonByInlineRatio;
  function getLocalPaddlePolygonBox(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 4) return null;
    const xs = polygon.map(point => Number(point && point.x)).filter(Number.isFinite);
    const ys = polygon.map(point => Number(point && point.y)).filter(Number.isFinite);
    if (xs.length < 4 || ys.length < 4) return null;
    return runtime.buildBaiduBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
  }

  /**
   * Keep visually different text layers as independent render candidates.
   * A paragraph may be spatially connected while still containing a username,
   * timestamp, heading, or message body with a different font size.
   */
  runtime.getLocalPaddlePolygonBox = getLocalPaddlePolygonBox;
}
