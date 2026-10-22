export function installVisionOcr(runtime) {
  function buildVisionCropOcrGroups(words, imageSize, lang = "korean") {
    const entries = words.map((item, index) => {
      const box = runtime.getBaiduItemBox(item);
      const text = String(item && item.words ? item.words : "").trim();
      const confidence = Number(item && item.confidence ? item.confidence : 0);
      return box && runtime.shouldRepairLocalPaddleWordWithVision(text, confidence, lang) ? {
        item,
        index,
        box,
        text,
        confidence
      } : null;
    }).filter(Boolean).sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left);
    const groups = [];
    entries.forEach(entry => {
      const group = groups.find(candidate => runtime.shouldJoinVisionCropOcrGroup(candidate, entry, imageSize));
      if (group) {
        group.push(entry);
      } else {
        groups.push([entry]);
      }
    });
    return groups;
  }
  runtime.buildVisionCropOcrGroups = buildVisionCropOcrGroups;
  function shouldRepairLocalPaddleWordWithVision(text, confidence, lang = "korean") {
    const raw = String(text || "").trim();
    if (!raw || confidence >= 0.78) {
      return false;
    }
    const hangul = (raw.match(/[\uac00-\ud7af]/g) || []).length;
    const jamo = (raw.match(/[\u3130-\u318f]/g) || []).length;
    const latin = (raw.match(/[A-Za-z]/g) || []).length;
    if (latin > 0 || jamo > 0) {
      return true;
    }
    if (lang === "japan") {
      const kana = (raw.match(/[\u3041-\u30ff]/g) || []).length;
      const kanji = (raw.match(/[\u3400-\u9fff]/g) || []).length;
      return kana + kanji <= 3 || confidence < 0.58;
    }
    return hangul <= 3 || confidence < 0.58;
  }
  runtime.shouldRepairLocalPaddleWordWithVision = shouldRepairLocalPaddleWordWithVision;
  function shouldJoinVisionCropOcrGroup(group, entry, imageSize) {
    const groupBox = runtime.getBaiduGroupBox(group.map(row => row.item));
    const box = entry.box;
    if (!groupBox || !box) {
      return false;
    }
    const avgHeight = Math.max(1, (groupBox.height + box.height) / 2);
    const verticalOverlap = Math.min(groupBox.bottom, box.bottom) - Math.max(groupBox.top, box.top);
    const sameLine = verticalOverlap >= Math.min(groupBox.height, box.height) * 0.38;
    if (!sameLine) {
      return false;
    }
    const gap = runtime.getHorizontalGap(groupBox, box);
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const unionWidth = Math.max(groupBox.right, box.right) - Math.min(groupBox.left, box.left);
    return gap <= avgHeight * 2.8 && unionWidth <= imageWidth * 0.72;
  }
  runtime.shouldJoinVisionCropOcrGroup = shouldJoinVisionCropOcrGroup;
  async function cropDataUrlByImageBox(dataUrl, box, imageSize) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const sourceWidth = Math.max(1, Number(imageSize && imageSize.width) || bitmap.width || 1);
      const sourceHeight = Math.max(1, Number(imageSize && imageSize.height) || bitmap.height || 1);
      const scaleX = bitmap.width / sourceWidth;
      const scaleY = bitmap.height / sourceHeight;
      const marginX = Math.max(8, box.width * 0.18);
      const marginY = Math.max(8, box.height * 0.22);
      const left = runtime.clamp(Math.floor((box.left - marginX) * scaleX), 0, bitmap.width - 1);
      const top = runtime.clamp(Math.floor((box.top - marginY) * scaleY), 0, bitmap.height - 1);
      const right = runtime.clamp(Math.ceil((box.right + marginX) * scaleX), left + 1, bitmap.width);
      const bottom = runtime.clamp(Math.ceil((box.bottom + marginY) * scaleY), top + 1, bitmap.height);
      const canvas = new OffscreenCanvas(Math.max(1, right - left), Math.max(1, bottom - top));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("OffscreenCanvas context unavailable for crop OCR");
      }
      ctx.drawImage(bitmap, left, top, right - left, bottom - top, 0, 0, canvas.width, canvas.height);
      const output = await canvas.convertToBlob({
        type: "image/png"
      });
      return runtime.blobToDataUrl(output);
    } finally {
      if (typeof bitmap.close === "function") {
        bitmap.close();
      }
    }
  }
  runtime.cropDataUrlByImageBox = cropDataUrlByImageBox;
  async function requestVisionCropOcr({
    dataUrl,
    apiKey,
    baseUrl,
    model,
    requestTimeoutMs,
    lang = "korean"
  }) {
    const prompt = buildVisionCropOcrPrompt(lang);
    const raw = await runtime.requestOpenAICompatibleVision({
      model,
      apiKey,
      baseUrl,
      dataUrl,
      prompt,
      requestTimeoutMs
    });
    try {
      const payload = runtime.parseModelJson(raw);
      return runtime.cleanDecorativeSymbols(String(payload && payload.text ? payload.text : "").trim());
    } catch {
      return runtime.cleanDecorativeSymbols(String(raw || "").replace(/```[\s\S]*?```/g, "").replace(/^[\s"'`{[\]]+|[\s"'`}\]]+$/g, "").trim());
    }
  }
  runtime.requestVisionCropOcr = requestVisionCropOcr;
  function buildVisionCropOcrPrompt(lang) {
    if (lang === "japan") {
      return [
        "Read the Japanese text in this cropped manga speech bubble.",
        "The text may be written vertically (tategaki): read each column top-to-bottom, columns ordered right-to-left.",
        "Small furigana beside kanji are pronunciation hints, not dialogue: do not include them.",
        "Return JSON only: {\"text\":\"...\"}.",
        "Do not translate. Preserve Japanese kana, kanji, spaces, and punctuation.",
        "If the crop is unreadable or contains no Japanese text, return {\"text\":\"\"}."
      ].join("\n");
    }
    if (lang === "korean") {
      return [
        "Read the Korean text in this cropped manga image.",
        "Return JSON only: {\"text\":\"...\"}.",
        "Do not translate. Preserve Korean text, spaces, and punctuation.",
        "If the crop is unreadable or contains no Korean text, return {\"text\":\"\"}."
      ].join("\n");
    }
    return [
      "Read the Japanese or Korean text in this cropped manga image.",
      "The text may be written vertically (tategaki): read each column top-to-bottom, columns ordered right-to-left.",
      "Return JSON only: {\"text\":\"...\"}.",
      "Do not translate. Preserve the original text, spaces, and punctuation.",
      "If the crop is unreadable or contains no Japanese/Korean text, return {\"text\":\"\"}."
    ].join("\n");
  }
  runtime.buildVisionCropOcrPrompt = buildVisionCropOcrPrompt;
  function isUsableVisionCropOcrText(text, lang = "korean") {
    const raw = String(text || "").trim();
    if (!raw || raw.length > 80) {
      return false;
    }
    if (lang === "japan") {
      const kana = (raw.match(/[\u3041-\u30ff]/g) || []).length;
      const kanji = (raw.match(/[\u3400-\u9fff]/g) || []).length;
      return kana + kanji >= 2;
    }
    if (lang !== "korean") {
      const japanese = (raw.match(/[\u3041-\u30ff\u3400-\u9fff]/g) || []).length;
      const hangulAny = (raw.match(/[\uac00-\ud7af]/g) || []).length;
      return japanese >= 2 || hangulAny >= 2;
    }
    const hangul = (raw.match(/[\uac00-\ud7af]/g) || []).length;
    return hangul >= 2;
  }
  runtime.isUsableVisionCropOcrText = isUsableVisionCropOcrText;
}
