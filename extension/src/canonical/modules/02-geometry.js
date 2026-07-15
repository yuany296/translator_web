export function installPipeline02(runtime) {
  function isKakaoStitchCandidatePastNeighborWindow(owner, candidate, direction) {
    if (!owner || !candidate) {
      return false;
    }
    const ownerTop = Number(owner.top || 0);
    const ownerBottom = Number(owner.bottom || Number(owner.top || 0) + Number(owner.height || 0));
    const candidateTop = Number(candidate.top || 0);
    const candidateBottom = Number(candidate.bottom || Number(candidate.top || 0) + Number(candidate.height || 0));
    return direction === "previous" ? candidateBottom < ownerTop - runtime.KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX : candidateTop > ownerBottom + runtime.KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX;
  }

  /** 在已建索引的候选列表中查找邻图目标 */
  runtime.isKakaoStitchCandidatePastNeighborWindow = isKakaoStitchCandidatePastNeighborWindow;
  function findKakaoStitchNeighborTarget(entries, fromIndex, direction) {
    if (!Array.isArray(entries) || entries.length === 0 || fromIndex < 0 || fromIndex >= entries.length) {
      return null;
    }
    const owner = entries[fromIndex];
    if (!owner || !owner.descriptor) return null;
    const step = direction === "previous" ? -1 : 1;
    const limit = direction === "previous" ? 0 : entries.length - 1;
    for (let i = fromIndex + step; direction === "previous" ? i >= limit : i <= limit; i += step) {
      const candidate = entries[i];
      if (!candidate || !candidate.descriptor) continue;
      if (runtime.isKakaoStitchCandidatePastNeighborWindow(owner.descriptor, candidate.descriptor, direction)) {
        break;
      }
      if (runtime.isVerifiedKakaoStitchNeighbor(owner.descriptor, candidate.descriptor, direction)) {
        return candidate.target;
      }
    }
    return null;
  }

  /** 在已建索引的候选列表中查找短页附着目标 */
  runtime.findKakaoStitchNeighborTarget = findKakaoStitchNeighborTarget;
  function findKakaoShortPageAttachmentOwnerTarget(entries, fromIndex, direction) {
    if (!Array.isArray(entries) || entries.length === 0 || fromIndex < 0 || fromIndex >= entries.length) {
      return null;
    }
    const target = entries[fromIndex];
    if (!target || !target.descriptor) return null;
    const step = direction === "previous" ? -1 : 1;
    const limit = direction === "previous" ? 0 : entries.length - 1;
    for (let i = fromIndex + step; direction === "previous" ? i >= limit : i <= limit; i += step) {
      const candidate = entries[i];
      if (!candidate || !candidate.descriptor) continue;
      const owner = candidate.descriptor;
      const candidateDesc = target.descriptor;
      const ownerDirection = direction === "previous" ? "next" : "previous";
      if (runtime.isKakaoStitchCandidatePastNeighborWindow(candidateDesc, owner, direction)) {
        break;
      }
      if (runtime.isVerifiedKakaoStitchNeighbor(owner, candidateDesc, ownerDirection) && runtime.isAttachableKakaoShortPage(candidateDesc, owner, candidateDesc.height, owner.height)) {
        return candidate.target;
      }
    }
    return null;
  }
  runtime.findKakaoShortPageAttachmentOwnerTarget = findKakaoShortPageAttachmentOwnerTarget;
  function findKakaoShortPageAttachmentOwner(target, candidates, describeTarget) {
    const ordered = Array.isArray(candidates) ? candidates : [];
    const index = ordered.indexOf(target);
    if (index < 0) {
      return null;
    }
    const entries = runtime.buildKakaoStitchCandidateEntries(ordered, describeTarget);
    if (!entries[index] || !entries[index].descriptor) {
      return null;
    }
    const previous = runtime.findKakaoShortPageAttachmentOwnerTarget(entries, index, "previous");
    if (previous) {
      return {
        owner: previous,
        direction: "next"
      };
    }
    const next = runtime.findKakaoShortPageAttachmentOwnerTarget(entries, index, "next");
    return next ? {
      owner: next,
      direction: "previous"
    } : null;
  }

  /* =================================================================
   * 重叠检测（纯像素运算）
   * ================================================================= */
  /** 创建灰度采样（纯函数——不操作 DOM canvas；接收 imageData 级别的数据） */
  runtime.findKakaoShortPageAttachmentOwner = findKakaoShortPageAttachmentOwner;
  function computeGraySample({
    data,
    width,
    height
  }) {
    if (!data || !width || !height) return null;
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = Math.round(data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
    }
    return {
      width,
      height,
      gray
    };
  }
  runtime.computeGraySample = computeGraySample;
  function findKakaoVerticalOverlap(previousSample, currentSample) {
    if (!previousSample || !currentSample || previousSample.width !== currentSample.width || !(previousSample.height > 0 && currentSample.height > 0) || !previousSample.gray || !currentSample.gray) {
      return null;
    }
    const width = previousSample.width;
    const maxRows = Math.floor(Math.min(previousSample.height, currentSample.height * runtime.KAKAO_OVERLAP_MAX_RATIO));
    const minRows = Math.ceil(currentSample.height * runtime.KAKAO_OVERLAP_MIN_RATIO);
    if (maxRows < minRows) return null;
    let bestRows = 0;
    let bestMae = Infinity;
    let bestInformativeMae = Infinity;
    let bestInformativeRatio = 0;
    let bestInformativeSpanRatio = 0;
    let bestScore = Infinity;
    let bestQualified = false;
    const step = Math.max(1, Math.round(currentSample.height / 180));
    for (let rows = minRows; rows <= maxRows; rows += step) {
      const previousOffset = (previousSample.height - rows) * width;
      let total = 0;
      let informativeTotal = 0;
      let informativeCount = 0;
      let firstInformativeRow = rows;
      let lastInformativeRow = -1;
      const count = rows * width;
      for (let offset = 0; offset < count; offset += 1) {
        const previousLuma = previousSample.gray[previousOffset + offset];
        const currentLuma = currentSample.gray[offset];
        const difference = Math.abs(previousLuma - currentLuma);
        total += difference;
        if (previousLuma <= runtime.KAKAO_OVERLAP_INFORMATIVE_LUMA || currentLuma <= runtime.KAKAO_OVERLAP_INFORMATIVE_LUMA || difference >= runtime.KAKAO_OVERLAP_INFORMATIVE_DIFF) {
          informativeTotal += difference;
          informativeCount += 1;
          const row = Math.floor(offset / width);
          firstInformativeRow = Math.min(firstInformativeRow, row);
          lastInformativeRow = Math.max(lastInformativeRow, row);
        }
      }
      const mae = total / Math.max(1, count);
      const informativeMae = informativeCount > 0 ? informativeTotal / informativeCount : 255;
      const informativeRatio = informativeCount / Math.max(1, count);
      const informativeSpanRatio = lastInformativeRow >= firstInformativeRow ? (lastInformativeRow - firstInformativeRow + 1) / Math.max(1, rows) : 0;
      const score = mae + informativeMae * 0.25;
      const qualified = mae <= runtime.KAKAO_OVERLAP_MAX_MAE && informativeRatio >= runtime.KAKAO_OVERLAP_MIN_INFORMATIVE_RATIO && informativeMae <= runtime.KAKAO_OVERLAP_MAX_INFORMATIVE_MAE && informativeSpanRatio >= runtime.KAKAO_OVERLAP_MIN_INFORMATIVE_SPAN_RATIO;
      if (qualified && !bestQualified || qualified === bestQualified && score < bestScore) {
        bestQualified = qualified;
        bestScore = score;
        bestMae = mae;
        bestInformativeMae = informativeMae;
        bestInformativeRatio = informativeRatio;
        bestInformativeSpanRatio = informativeSpanRatio;
        bestRows = rows;
      }
    }
    const uniqueRows = currentSample.height - bestRows;
    const accepted = bestMae <= runtime.KAKAO_OVERLAP_MAX_MAE && bestInformativeRatio >= runtime.KAKAO_OVERLAP_MIN_INFORMATIVE_RATIO && bestInformativeMae <= runtime.KAKAO_OVERLAP_MAX_INFORMATIVE_MAE && bestInformativeSpanRatio >= runtime.KAKAO_OVERLAP_MIN_INFORMATIVE_SPAN_RATIO && bestRows >= minRows && bestRows <= maxRows && uniqueRows / Math.max(1, currentSample.height) >= 1 - runtime.KAKAO_OVERLAP_MAX_RATIO;
    return {
      accepted,
      rows: bestRows,
      previousRows: previousSample.height,
      currentRows: currentSample.height,
      mae: bestMae,
      informativeMae: bestInformativeMae,
      informativeRatio: bestInformativeRatio,
      informativeSpanRatio: bestInformativeSpanRatio,
      overlapRatio: bestRows / Math.max(1, currentSample.height)
    };
  }
  runtime.findKakaoVerticalOverlap = findKakaoVerticalOverlap;
  function hasUsableKakaoStripCaptureRect(captureRect) {
    return !!captureRect && captureRect.height >= 180 && captureRect.width >= 180;
  }
  runtime.hasUsableKakaoStripCaptureRect = hasUsableKakaoStripCaptureRect;
  function markSingleKakaoPayload(payload, target, rejectionReason, adapters) {
    const reason = String(rejectionReason || "").trim();
    return {
      ...payload,
      ocrMode: "single",
      sourceToken: adapters.getQuickSourceToken(target),
      ...(reason ? {
        stitchAdmission: "rejected",
        stitchRejectionReason: reason
      } : {})
    };
  }

  /** 构建 Kakao 邻页拼接画布；DOM 与图像解码能力全部由适配器提供。 */
  runtime.markSingleKakaoPayload = markSingleKakaoPayload;
}
