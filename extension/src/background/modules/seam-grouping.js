export function installSeamGrouping(runtime) {
  function candidateLineCount(candidate) {
    const explicit = Math.round(Number(candidate?.source_line_count) || 0);
    const textLines = String(candidate?.original_text || "").split(/\n+/u).filter(Boolean).length;
    return Math.max(1, explicit, textLines);
  }

  function isSeamSpeechRegionCandidate(descriptor) {
    const candidate = descriptor?.candidate;
    const regionId = String(candidate?.region_id || "");
    const regionType = String(candidate?.region_type || "").toLowerCase();
    const translationRole = runtime.normalizeChatTranslationRole(
      candidate?.translation_role || candidate?.translationRole
    );
    return Boolean(regionId) && regionType === "speech_bubble" && !translationRole;
  }

  function groupFitsSeamWindow(descriptors, maxCrossHeight) {
    const boxes = descriptors.map(item => item.rawBox).filter(Boolean);
    if (boxes.length !== descriptors.length) return false;
    const top = Math.min(...boxes.map(box => box.top));
    const bottom = Math.max(...boxes.map(box => box.top + box.height));
    if (bottom - top > maxCrossHeight) return false;
    const ordered = [...boxes].sort((left, right) => left.top - right.top || left.left - right.left);
    return ordered.slice(1).every((box, index) => {
      const previous = ordered[index];
      const gap = box.top - (previous.top + previous.height);
      return gap <= runtime.resolveSeamCrossPairMaxGap(previous, box, maxCrossHeight);
    });
  }

  function mergeSeamSpeechRegion(descriptors) {
    const candidates = descriptors.map(item => item.candidate);
    const merged = runtime.mergeOcrCandidateGroup(candidates, 0);
    if (!merged) return null;
    const indices = descriptors.map(item => item.index).sort((left, right) => left - right);
    const lineCount = candidates.reduce((sum, candidate) => sum + candidateLineCount(candidate), 0);
    return {
      ...merged,
      id: `seam-region:${String(candidates[0]?.region_id || "")}:${indices.join("-")}`,
      source_line_count: lineCount
    };
  }

  function isAnonymousSeamBodyCandidate(descriptor) {
    const candidate = descriptor?.candidate;
    const text = runtime.normalizeTranslationSourceText(candidate?.original_text);
    const role = runtime.normalizeChatTranslationRole(
      candidate?.translation_role || candidate?.translationRole
    );
    const bodyRole = runtime.CHAT_TRANSLATION_ROLES?.body || "chat_body";
    const confidence = Number(candidate?.confidence ?? candidate?.score) || 0;
    return Boolean(
      candidate &&
      text &&
      confidence >= 0.8 &&
      candidate.non_translate !== true &&
      (!role || role === bodyRole) &&
      !runtime.CHAT_TIME_RE.test(text)
    );
  }

  function areAnonymousSeamLinesCompatible(left, right) {
    if (!isAnonymousSeamBodyCandidate(left) || !isAnonymousSeamBodyCandidate(right)) {
      return false;
    }
    const [upper, lower] = [left, right].sort((a, b) =>
      a.rawBox.top - b.rawBox.top || a.rawBox.left - b.rawBox.left
    );
    const upperBox = upper.rawBox;
    const lowerBox = lower.rawBox;
    const averageHeight = Math.max(1, (upperBox.height + lowerBox.height) / 2);
    const heightRatio = Math.min(upperBox.height, lowerBox.height) /
      Math.max(upperBox.height, lowerBox.height, 1);
    const overlap = Math.max(0,
      Math.min(upperBox.left + upperBox.width, lowerBox.left + lowerBox.width) -
      Math.max(upperBox.left, lowerBox.left)
    ) / Math.max(1, Math.min(upperBox.width, lowerBox.width));
    const gap = lowerBox.top - (upperBox.top + upperBox.height);
    const upperRotation = Number(upper.candidate?.rotation_deg) || 0;
    const lowerRotation = Number(lower.candidate?.rotation_deg) || 0;
    return (
      heightRatio >= 0.7 &&
      overlap >= 0.4 &&
      gap >= -averageHeight * 0.25 &&
      gap <= averageHeight * 0.7 &&
      Math.abs(upperRotation - lowerRotation) <= 12
    );
  }

  function buildAnonymousSeamBodyGroups(descriptors, usedIndices, maxCrossHeight) {
    const available = descriptors.filter(descriptor =>
      !usedIndices.has(descriptor.index) &&
      !isSeamSpeechRegionCandidate(descriptor) &&
      isAnonymousSeamBodyCandidate(descriptor)
    );
    const pending = new Set(available.map(descriptor => descriptor.index));
    const byIndex = new Map(available.map(descriptor => [descriptor.index, descriptor]));
    const groups = [];
    while (pending.size > 0) {
      const [start] = pending;
      pending.delete(start);
      const component = [byIndex.get(start)];
      for (let cursor = 0; cursor < component.length; cursor += 1) {
        const current = component[cursor];
        for (const index of [...pending]) {
          const candidate = byIndex.get(index);
          if (!areAnonymousSeamLinesCompatible(current, candidate)) continue;
          pending.delete(index);
          component.push(candidate);
        }
      }
      if (component.length < 3 || !groupFitsSeamWindow(component, maxCrossHeight)) continue;
      const anchored = component.some(item => item.crossesBoundary) ||
        component.some(item => item.upperEdgeOnly) &&
        component.some(item => item.lowerEdgeOnly);
      if (!anchored) continue;
      groups.push(component);
    }
    return groups;
  }

  function buildSeamRegionCandidateGroups(descriptors, maxCrossHeight) {
    const byRegion = new Map();
    for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
      if (!isSeamSpeechRegionCandidate(descriptor)) continue;
      const regionId = String(descriptor.candidate.region_id);
      byRegion.set(regionId, [...(byRegion.get(regionId) || []), descriptor]);
    }
    const usedIndices = new Set();
    const candidates = [];
    for (const [, group] of [...byRegion.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (group.length < 2 || !groupFitsSeamWindow(group, maxCrossHeight)) continue;
      const anchored = group.some(item => item.crossesBoundary) ||
        group.some(item => item.upperEdgeOnly) && group.some(item => item.lowerEdgeOnly);
      if (!anchored) continue;
      const merged = mergeSeamSpeechRegion(group);
      if (!merged) continue;
      candidates.push(merged);
      group.forEach(item => usedIndices.add(item.index));
    }
    const anonymousGroups = buildAnonymousSeamBodyGroups(
      Array.isArray(descriptors) ? descriptors : [],
      usedIndices,
      maxCrossHeight
    );
    anonymousGroups.forEach(group => {
      const merged = mergeSeamSpeechRegion(group);
      if (!merged) return;
      merged.id = `seam-body:${group.map(item => item.index).sort((a, b) => a - b).join("-")}`;
      candidates.push(merged);
      group.forEach(item => usedIndices.add(item.index));
    });
    return { candidates, usedIndices };
  }
  runtime.buildSeamRegionCandidateGroups = buildSeamRegionCandidateGroups;
}
