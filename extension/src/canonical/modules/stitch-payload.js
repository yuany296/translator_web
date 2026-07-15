export function installStitchPayload(runtime) {
  /** 构建 Kakao 邻页拼接画布；DOM 与图像解码能力全部由适配器提供。 */
  async function buildKakaoStitchedPayload(target, ownerPayload, adapters) {
    const singlePayload = runtime.markSingleKakaoPayload(ownerPayload, target, "", adapters);
    const ordered = adapters.collectCandidates(target).filter(adapters.isReadyImageTarget);
    const ownerIndex = ordered.indexOf(target);
    if (ownerIndex < 0) {
      return runtime.markSingleKakaoPayload(ownerPayload, target, "owner not found", adapters);
    }
    const orderedEntries = runtime.buildKakaoStitchCandidateEntries(ordered, adapters.describeTarget);
    const ownerDescriptor = orderedEntries[ownerIndex] && orderedEntries[ownerIndex].descriptor;
    const previousTarget = runtime.findKakaoStitchNeighborTarget(orderedEntries, ownerIndex, "previous");
    const nextTarget = runtime.findKakaoStitchNeighborTarget(orderedEntries, ownerIndex, "next");
    if (!previousTarget && !nextTarget) {
      return runtime.markSingleKakaoPayload(ownerPayload, target, "no verified neighbor", adapters);
    }
    const previousPayload = previousTarget ? await adapters.extractAdjacentPayload(previousTarget) : null;
    const nextPayload = nextTarget ? await adapters.extractAdjacentPayload(nextTarget) : null;
    const decoded = await Promise.all([previousPayload, ownerPayload, nextPayload].filter(Boolean).map(payload => adapters.loadImage(payload.dataUrl)));
    let decodedIndex = 0;
    const previousImage = previousPayload ? decoded[decodedIndex++] : null;
    const ownerImage = decoded[decodedIndex++];
    const nextImage = nextPayload ? decoded[decodedIndex] : null;
    const canonicalWidth = Math.max(1, Math.min(Number(adapters.imageMaxSide || 1536), Number(ownerPayload.width) || ownerImage.naturalWidth || ownerImage.width));
    const scaledHeight = image => Math.max(1, Math.round((image.naturalHeight || image.height) / Math.max(1, image.naturalWidth || image.width) * canonicalWidth));
    const ownerHeight = scaledHeight(ownerImage);
    const previousHeight = previousImage ? scaledHeight(previousImage) : 0;
    const nextHeight = nextImage ? scaledHeight(nextImage) : 0;
    const previousDescriptor = previousTarget ? adapters.describeTarget(previousTarget) : null;
    const nextDescriptor = nextTarget ? adapters.describeTarget(nextTarget) : null;
    const rejection = runtime.shouldRejectKakaoPageEdgeStitch({
      owner: ownerDescriptor,
      ownerHeight,
      canonicalWidth,
      previous: previousDescriptor,
      next: nextDescriptor,
      previousHeight,
      nextHeight
    });
    if (rejection) {
      return runtime.markSingleKakaoPayload(singlePayload, target, rejection, adapters);
    }
    const plan = runtime.buildKakaoStitchWindowPlan({
      owner: ownerDescriptor,
      previous: previousDescriptor,
      next: nextDescriptor,
      canonicalWidth,
      ownerHeight,
      previousHeight,
      nextHeight
    });
    const previousSlice = previousImage ? plan.previousSlice : 0;
    const nextSlice = nextImage ? plan.nextSlice : 0;
    if (previousSlice <= 0 && nextSlice <= 0) {
      return runtime.markSingleKakaoPayload(ownerPayload, target, "empty stitch slices", adapters);
    }
    const compositeHeight = previousSlice + ownerHeight + nextSlice;
    const ownerEntry = {
      source: "owner",
      targetKey: adapters.computeTargetKey(target),
      src: adapters.getQuickSourceToken(target),
      drawRect: {
        x: 0,
        y: previousSlice,
        w: canonicalWidth,
        h: ownerHeight
      },
      sourceCrop: {
        x: 0,
        y: 0,
        w: ownerImage.naturalWidth || ownerImage.width,
        h: ownerImage.naturalHeight || ownerImage.height
      },
      naturalWidth: ownerImage.naturalWidth || ownerImage.width,
      naturalHeight: ownerImage.naturalHeight || ownerImage.height
    };
    const buildNeighborEntry = (source, neighborTarget, image, slice, fullHeight, drawY, shortPage) => {
      if (!neighborTarget || !image || !(slice > 0)) return null;
      const naturalWidth = image.naturalWidth || image.width;
      const naturalHeight = image.naturalHeight || image.height;
      const sourceCropHeight = naturalHeight * (slice / Math.max(1, fullHeight));
      return {
        source,
        shortPageAttachment: shortPage === true && slice >= fullHeight - 1,
        targetKey: adapters.computeTargetKey(neighborTarget),
        src: adapters.getQuickSourceToken(neighborTarget),
        drawRect: {
          x: 0,
          y: drawY,
          w: canonicalWidth,
          h: slice
        },
        sourceCrop: {
          x: 0,
          y: source === "previous" ? naturalHeight - sourceCropHeight : 0,
          w: naturalWidth,
          h: sourceCropHeight
        },
        naturalWidth,
        naturalHeight
      };
    };
    const previousEntry = buildNeighborEntry("previous", previousTarget, previousImage, previousSlice, previousHeight, 0, plan.previousShortPageAttachment);
    const nextEntry = buildNeighborEntry("next", nextTarget, nextImage, nextSlice, nextHeight, previousSlice + ownerHeight, plan.nextShortPageAttachment);
    const segments = [previousEntry, ownerEntry, nextEntry].filter(Boolean);
    const canvas = adapters.createCanvas(canonicalWidth, compositeHeight);
    const context = canvas && canvas.getContext("2d");
    if (!context) return singlePayload;
    if (previousImage && previousSlice > 0) {
      const height = previousImage.naturalHeight || previousImage.height;
      const width = previousImage.naturalWidth || previousImage.width;
      const sourceHeight = height * (previousSlice / previousHeight);
      context.drawImage(previousImage, 0, height - sourceHeight, width, sourceHeight, 0, 0, canonicalWidth, previousSlice);
    }
    context.drawImage(ownerImage, 0, 0, canonicalWidth, ownerHeight, 0, previousSlice, canonicalWidth, ownerHeight);
    if (nextImage && nextSlice > 0) {
      const height = nextImage.naturalHeight || nextImage.height;
      const width = nextImage.naturalWidth || nextImage.width;
      const sourceHeight = height * (nextSlice / nextHeight);
      context.drawImage(nextImage, 0, 0, width, sourceHeight, 0, previousSlice + ownerHeight, canonicalWidth, nextSlice);
    }
    const sourceKeys = [previousTarget, target, nextTarget].map(item => item ? adapters.getQuickSourceToken(item) : "edge");
    return {
      ...ownerPayload,
      ocrMode: "stitch",
      stitchAdmission: "accepted",
      sourceToken: adapters.getQuickSourceToken(target),
      dataUrl: canvas.toDataURL("image/jpeg", Number(adapters.imageJpegQuality || 0.82)),
      imageUrl: `kakao-stitch:${sourceKeys.join("|")}`,
      width: canonicalWidth,
      height: compositeHeight,
      stitchKey: `${adapters.computeTargetKey(target)}|stitch:${previousSlice}:${nextSlice}|${sourceKeys.join("|")}`,
      singleImagePayload: ownerPayload,
      attachedShortPageKeys: [previousEntry, nextEntry].filter(entry => entry && entry.shortPageAttachment).map(entry => adapters.buildTargetSourceCacheKey(entry.targetKey, entry.src)),
      stitch: {
        canvasWidth: canonicalWidth,
        canvasHeight: compositeHeight,
        sourceKeys,
        verified: true,
        ocrMode: "stitch",
        owner: ownerEntry,
        previous: previousEntry,
        next: nextEntry,
        segments
      }
    };
  }
  runtime.buildKakaoStitchedPayload = buildKakaoStitchedPayload;
  function isKakaoStripPayload(payload, targetRect) {
    const payloadHeight = Number(payload && payload.height || 0);
    const payloadWidth = Number(payload && payload.width || 0);
    const cssHeight = Number(payload && payload.cssHeight || targetRect && targetRect.height || 0);
    const cssWidth = Number(payload && payload.cssWidth || targetRect && targetRect.width || 0);
    return payloadHeight < 220 || cssHeight < 180 || payloadWidth / Math.max(1, payloadHeight) > 5.2 || cssWidth / Math.max(1, cssHeight) > 5.2;
  }
  runtime.isKakaoStripPayload = isKakaoStripPayload;
  function hasUsefulKakaoOverlapCrop(cropTop, cropHeight, currentHeight) {
    const sourceHeight = Math.max(1, Number(currentHeight) || 1);
    const uniqueHeight = Number(cropHeight) || 0;
    return Number(cropTop) > 0 && uniqueHeight >= runtime.KAKAO_OVERLAP_MIN_UNIQUE_PX && uniqueHeight / sourceHeight >= runtime.KAKAO_OVERLAP_MIN_UNIQUE_RATIO;
  }

  /** 检测相邻图片的重复像素并裁掉当前页顶部重叠区域。 */
  runtime.hasUsefulKakaoOverlapCrop = hasUsefulKakaoOverlapCrop;
  async function maybeCropKakaoOverlappedPayload(target, payload, adapters) {
    if (!adapters.isReadyImageTarget(target) || !payload || payload.kakaoOverlapCrop === true || !adapters.isDataUrl(payload.dataUrl) || adapters.directCapture !== true) {
      return null;
    }
    const ordered = adapters.collectCandidates(target).filter(adapters.isReadyImageTarget);
    const index = ordered.indexOf(target);
    const entries = runtime.buildKakaoStitchCandidateEntries(ordered, adapters.describeTarget);
    const currentDescriptor = entries[index] && entries[index].descriptor;
    const previous = runtime.findKakaoStitchNeighborTarget(entries, index, "previous");
    const previousDescriptor = adapters.describeTarget(previous);
    if (!previous || !runtime.isVerifiedKakaoStitchNeighbor(previousDescriptor, currentDescriptor, "next") || runtime.isAttachableKakaoShortPage(currentDescriptor, previousDescriptor, currentDescriptor && currentDescriptor.height, previousDescriptor && previousDescriptor.height)) {
      return null;
    }
    const previousPayload = await adapters.getNeighborPayload(previous);
    if (!previousPayload || !adapters.isDataUrl(previousPayload.dataUrl)) {
      return null;
    }
    const [previousImage, currentImage] = await Promise.all([adapters.loadImage(previousPayload.dataUrl), adapters.loadImage(payload.dataUrl)]);
    const currentWidth = currentImage.naturalWidth || currentImage.width || Number(payload.width || 0);
    const currentHeight = currentImage.naturalHeight || currentImage.height || Number(payload.height || 0);
    const previousWidth = previousImage.naturalWidth || previousImage.width || Number(previousPayload.width || 0);
    const previousHeight = previousImage.naturalHeight || previousImage.height || Number(previousPayload.height || 0);
    if (!(currentWidth > 0 && currentHeight > 0 && previousWidth > 0 && previousHeight > 0) || Math.min(currentWidth, previousWidth) / Math.max(currentWidth, previousWidth) < runtime.KAKAO_STITCH_MIN_WIDTH_RATIO) {
      return null;
    }
    const overlap = runtime.findKakaoVerticalOverlap(adapters.sampleImage(previousImage), adapters.sampleImage(currentImage));
    if (!overlap || !overlap.accepted) {
      return null;
    }
    const cropTop = Math.round(overlap.rows / Math.max(1, overlap.currentRows) * currentHeight);
    const cropHeight = currentHeight - cropTop;
    if (!runtime.hasUsefulKakaoOverlapCrop(cropTop, cropHeight, currentHeight)) {
      return null;
    }
    const canvas = adapters.createCanvas(currentWidth, cropHeight);
    const context = canvas && canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(currentImage, 0, cropTop, currentWidth, cropHeight, 0, 0, currentWidth, cropHeight);
    const rect = adapters.getTargetRect(target);
    const cssWidth = Number(payload.cssWidth || rect.width || 0);
    const cssHeight = Number(payload.cssHeight || rect.height || 0);
    const cropCssY = cssHeight * (cropTop / Math.max(1, currentHeight));
    const cropCssHeight = cssHeight * (cropHeight / Math.max(1, currentHeight));
    return {
      ...payload,
      dataUrl: canvas.toDataURL("image/jpeg", Number(adapters.imageJpegQuality || 0.82)),
      width: currentWidth,
      height: cropHeight,
      source: "kakao-overlap-crop",
      coordinateSpace: "source-image-v1",
      kakaoOverlapCrop: true,
      overlapCropTop: cropTop,
      imageUrl: `${payload.imageUrl || adapters.getQuickSourceToken(target)}#overlap-crop-${cropTop}`,
      displayRect: {
        offsetX: 0,
        offsetY: cropCssY,
        width: cssWidth,
        height: cropCssHeight
      }
    };
  }

  /* =================================================================
   * 拼接结果映射（纯）
   * ================================================================= */
  runtime.maybeCropKakaoOverlappedPayload = maybeCropKakaoOverlappedPayload;
  function normalizeKakaoStitchSegments(stitch, compositeWidth, compositeHeight, ownerDraw) {
    const rawSegments = Array.isArray(stitch && stitch.segments) ? stitch.segments : [];
    const segments = rawSegments.filter(seg => seg && seg.drawRect).map(seg => ({
      ...seg,
      drawRect: runtime.normalizeRectLike(seg.drawRect)
    })).filter(seg => seg.drawRect && seg.drawRect.w > 0 && seg.drawRect.h > 0);
    if (segments.length > 0) return segments;

    // Fallback: derive from canvas dimensions and ownerDraw
    const cw = Number(stitch && stitch.canvasWidth) || compositeWidth;
    const ch = Number(stitch && stitch.canvasHeight) || compositeHeight;
    const prevSlice = Math.max(0, Number(stitch && (stitch.previousSlice || stitch.previous && stitch.previous.drawRect && stitch.previous.drawRect.h)) || 0);
    const nextSlice = Math.max(0, Number(stitch && (stitch.nextSlice || stitch.next && stitch.next.drawRect && stitch.next.drawRect.h)) || 0);
    const owner = runtime.normalizeRectLike(ownerDraw) || {
      x: 0,
      y: prevSlice,
      w: cw,
      h: Math.max(1, ch - prevSlice - nextSlice)
    };
    const fallback = [];
    if (prevSlice > 0) {
      fallback.push({
        source: "previous",
        drawRect: {
          x: 0,
          y: 0,
          w: cw,
          h: prevSlice
        }
      });
    }
    fallback.push({
      source: "owner",
      drawRect: owner
    });
    if (nextSlice > 0) {
      fallback.push({
        source: "next",
        drawRect: {
          x: 0,
          y: owner.y + owner.h,
          w: cw,
          h: nextSlice
        }
      });
    }
    return fallback;
  }
  runtime.normalizeKakaoStitchSegments = normalizeKakaoStitchSegments;
  function getKakaoStitchBestOverlap(bubbleRect, segments) {
    if (!bubbleRect || !Array.isArray(segments) || segments.length === 0) return null;
    const area = Math.max(1, bubbleRect.w * bubbleRect.h);
    const ranked = segments.map(seg => {
      const rect = seg && seg.drawRect;
      if (!rect) return {
        segment: seg,
        ratio: 0
      };
      const left = Math.max(bubbleRect.x, rect.x);
      const top = Math.max(bubbleRect.y, rect.y);
      const right = Math.min(bubbleRect.x + bubbleRect.w, rect.x + rect.w);
      const bottom = Math.min(bubbleRect.y + bubbleRect.h, rect.y + rect.h);
      const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
      return {
        segment: seg,
        ratio: overlap / area
      };
    }).sort((a, b) => b.ratio - a.ratio);
    return ranked[0] || null;
  }
  runtime.getKakaoStitchBestOverlap = getKakaoStitchBestOverlap;
  function getKakaoStitchOwnerOverlap(bubbleRect, segments) {
    const best = runtime.getKakaoStitchBestOverlap(bubbleRect, segments);
    return best && best.segment && best.segment.source === "owner" && best.ratio >= 0.6 ? best : null;
  }
  runtime.getKakaoStitchOwnerOverlap = getKakaoStitchOwnerOverlap;
  function mapKakaoStitchedFillBox(box, ownerY, ownerH, compositeH) {
    if (!box || typeof box !== "object") return null;
    const x = Number(box.x);
    const y = Number(box.y);
    const w = Number(box.w);
    const h = Number(box.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    const topPx = y / 100 * compositeH;
    const heightPx = h / 100 * compositeH;
    const mappedH = heightPx / ownerH * 100;
    if (mappedH > 300) return null;
    return {
      x,
      y: (topPx - ownerY) / ownerH * 100,
      w,
      h: mappedH
    };
  }
  runtime.mapKakaoStitchedFillBox = mapKakaoStitchedFillBox;
}
