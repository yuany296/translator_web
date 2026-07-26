export function installBaiduProvider(runtime) {
  async function requestBaiduAccurateOcr({
    dataUrl,
    apiKey,
    secretKey
  }) {
    const accessToken = await runtime.requestBaiduAccessToken({
      apiKey,
      secretKey
    });
    return runtime.enqueueBaiduOcrRequest(() => runtime.requestBaiduAccurateOcrOnce({
      dataUrl,
      accessToken
    }));
  }
  runtime.requestBaiduAccurateOcr = requestBaiduAccurateOcr;
  async function enqueueBaiduOcrRequest(taskFactory) {
    const run = runtime.baiduOcrQueue.catch(() => {
      // 前一个 OCR 失败不应阻塞后续排队任务。
    }).then(() => runtime.runBaiduOcrWithThrottle(taskFactory));
    runtime.baiduOcrQueue = run.catch(() => {
      // 队列状态只负责串行化，错误交给当前调用方处理。
    });
    return run;
  }
  runtime.enqueueBaiduOcrRequest = enqueueBaiduOcrRequest;
  async function runBaiduOcrWithThrottle(taskFactory) {
    let attempt = 0;
    while (true) {
      await runtime.waitForBaiduOcrSlot();
      try {
        runtime.baiduLastOcrRequestAt = Date.now();
        return await taskFactory();
      } catch (error) {
        if (!runtime.isBaiduQpsLimitError(error) || attempt >= runtime.BAIDU_OCR_QPS_RETRY_DELAYS_MS.length) {
          throw error;
        }
        const delayMs = runtime.BAIDU_OCR_QPS_RETRY_DELAYS_MS[attempt];
        attempt += 1;
        await runtime.delay(delayMs);
      }
    }
  }
  runtime.runBaiduOcrWithThrottle = runBaiduOcrWithThrottle;
  async function waitForBaiduOcrSlot() {
    const elapsed = Date.now() - runtime.baiduLastOcrRequestAt;
    const waitMs = runtime.BAIDU_OCR_MIN_REQUEST_GAP_MS - elapsed;
    if (waitMs > 0) {
      await runtime.delay(waitMs);
    }
  }
  runtime.waitForBaiduOcrSlot = waitForBaiduOcrSlot;
  function isBaiduQpsLimitError(error) {
    const reason = runtime.getErrorMessage(error);
    return /\b18\b/.test(reason) || /qps request limit|open api qps|rate limit/i.test(reason);
  }
  runtime.isBaiduQpsLimitError = isBaiduQpsLimitError;
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }
  runtime.delay = delay;
  async function requestBaiduAccurateOcrOnce({
    dataUrl,
    accessToken
  }) {
    const endpoint = `https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=${encodeURIComponent(accessToken)}`;
    const parsed = runtime.parseDataUrl(dataUrl);
    const body = new URLSearchParams();
    body.set("image", parsed.base64Data);
    body.set("detect_direction", "false");
    body.set("vertexes_location", "false");
    body.set("paragraph", "true");
    body.set("probability", "false");
    body.set("char_probability", "false");
    body.set("multidirectional_recognize", "true");
    body.set("language_type", "auto_detect");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
    const payload = await runtime.safeJson(response);
    if (!response.ok || !payload || payload.error_code) {
      throw new Error(`Baidu OCR request failed: ${runtime.formatBaiduError(payload, response)}`);
    }
    return {
      words_result: Array.isArray(payload.words_result) ? payload.words_result : [],
      paragraphs_result: Array.isArray(payload.paragraphs_result) ? payload.paragraphs_result : []
    };
  }
  runtime.requestBaiduAccurateOcrOnce = requestBaiduAccurateOcrOnce;
  async function requestBaiduAccessToken({
    apiKey,
    secretKey
  }) {
    const now = Date.now();
    if (runtime.baiduAccessTokenCache && runtime.baiduAccessTokenCache.apiKey === apiKey && runtime.baiduAccessTokenCache.secretKey === secretKey && runtime.baiduAccessTokenCache.expiresAt > now + 60 * 1000) {
      return runtime.baiduAccessTokenCache.token;
    }
    const url = "https://aip.baidubce.com/oauth/2.0/token" + `?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}` + `&client_secret=${encodeURIComponent(secretKey)}`;
    const response = await fetch(url, {
      method: "POST"
    });
    const payload = await runtime.safeJson(response);
    if (!response.ok || !payload || payload.error) {
      throw new Error(`Baidu token request failed: ${runtime.formatBaiduError(payload, response)}`);
    }
    const token = String(payload.access_token || "").trim();
    if (!token) {
      throw new Error("Baidu token response missing access_token");
    }
    const expiresIn = Math.max(300, Number(payload.expires_in || 2592000));
    runtime.baiduAccessTokenCache = {
      apiKey,
      secretKey,
      token,
      expiresAt: now + expiresIn * 1000
    };
    return token;
  }
  runtime.requestBaiduAccessToken = requestBaiduAccessToken;
  function buildBaiduBubbleItems(payload, imageSize, ocrTuning = runtime.getDefaultOcrTuning(), ocrDebug = null) {
    const words = Array.isArray(payload && payload.words_result) ? payload.words_result : [];
    if (words.length === 0) {
      return [];
    }
    if (ocrDebug) {
      ocrDebug.rawItems = words.map((item, index) => runtime.toDebugOcrItem(item, index, imageSize, "raw"));
    }
    const usedIndexes = new Set();
    const filteredWords = words.filter((item, index) => runtime.keepOrTraceOcrWord(item, imageSize, ocrTuning, ocrDebug, index, "baidu"));
    if (ocrDebug) {
      ocrDebug.filteredItems = filteredWords.map((item, index) => runtime.toDebugOcrItem(item, index, imageSize, "filtered"));
    }
    const filteredIndexes = new Set(filteredWords.map(item => words.indexOf(item)));
    const paragraphItems = runtime.buildBaiduParagraphItems(payload, words, imageSize, usedIndexes, filteredIndexes);
    const remainingItems = filteredWords.filter(item => !usedIndexes.has(words.indexOf(item)) && runtime.getBaiduItemBox(item));
    const geometricItems = runtime.mergeBaiduGeometryItems(remainingItems, imageSize, ocrTuning);
    const mergedItems = [...paragraphItems, ...geometricItems].filter(item => item && item.words && item.location).sort(runtime.compareBaiduWordItems);
    if (ocrDebug) {
      ocrDebug.mergedItems = mergedItems.map((item, index) => runtime.toDebugOcrItem(item, index, imageSize, "merged"));
    }
    return mergedItems;
  }
  runtime.buildBaiduBubbleItems = buildBaiduBubbleItems;
  function buildBaiduParagraphItems(payload, words, imageSize, usedIndexes, filteredIndexes = null) {
    const paragraphs = Array.isArray(payload && payload.paragraphs_result) ? payload.paragraphs_result : [];
    const grouped = [];
    paragraphs.forEach(paragraph => {
      const indexes = Array.isArray(paragraph.words_result_idx) ? paragraph.words_result_idx : [];
      const group = indexes.map(index => {
        const numericIndex = Number(index);
        const item = words[numericIndex];
        if (filteredIndexes && !filteredIndexes.has(numericIndex)) {
          return null;
        }
        if (!item || !runtime.getBaiduItemBox(item)) {
          return null;
        }
        usedIndexes.add(numericIndex);
        return item;
      }).filter(Boolean);
      if (group.length > 0) {
        grouped.push(runtime.mergeBaiduWordItems(group, imageSize));
      }
    });
    return grouped;
  }
  runtime.buildBaiduParagraphItems = buildBaiduParagraphItems;
  function mergeBaiduGeometryItems(items, imageSize, ocrTuning = runtime.getDefaultOcrTuning()) {
    const sorted = items.filter(item => item && runtime.getBaiduItemBox(item)).sort(runtime.compareBaiduWordItems);
    const groups = [];
    sorted.forEach(item => {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup && runtime.shouldMergeBaiduWordItem(lastGroup, item, imageSize, ocrTuning)) {
        lastGroup.push(item);
        return;
      }
      groups.push([item]);
    });
    return groups.map(group => runtime.mergeBaiduWordItems(group, imageSize));
  }
  runtime.mergeBaiduGeometryItems = mergeBaiduGeometryItems;
  function shouldMergeBaiduWordItem(group, item, imageSize, ocrTuning = runtime.getDefaultOcrTuning()) {
    const groupBox = runtime.getBaiduGroupBox(group);
    const itemBox = runtime.getBaiduItemBox(item);
    if (!groupBox || !itemBox) {
      return false;
    }
    const avgHeight = Math.max(1, runtime.getBaiduAverageHeight([...group, item]));
    const verticalOverlap = Math.min(groupBox.bottom, itemBox.bottom) - Math.max(groupBox.top, itemBox.top);
    const sameLine = verticalOverlap >= Math.min(groupBox.height, itemBox.height) * 0.45;
    const horizontalGap = itemBox.left > groupBox.right ? itemBox.left - groupBox.right : groupBox.left > itemBox.right ? groupBox.left - itemBox.right : 0;
    if (sameLine) {
      return horizontalGap <= avgHeight * 2.2;
    }
    const verticalGap = itemBox.top - groupBox.bottom;
    const mergeGap = Math.max(0.2, Number(ocrTuning.mergeLineGap || runtime.BAIDU_MERGE_MAX_GAP_RATIO));
    if (verticalGap < -avgHeight * 0.5 || verticalGap > avgHeight * mergeGap) {
      return false;
    }
    const centerDistance = Math.abs(itemBox.centerX - groupBox.centerX);
    const maxWidth = Math.max(groupBox.width, itemBox.width, avgHeight * 4);
    const indent = Math.abs(itemBox.left - groupBox.left);
    const overlapX = Math.min(groupBox.right, itemBox.right) - Math.max(groupBox.left, itemBox.left);
    const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(groupBox.width, itemBox.width)) : 0;
    const groupWidthRatio = imageSize && imageSize.width > 0 ? groupBox.width / imageSize.width : 0;
    return centerDistance <= maxWidth * 0.62 && groupWidthRatio <= runtime.BAIDU_MERGE_MAX_WIDTH_RATIO && (overlapRatio >= 0.2 || indent <= avgHeight * runtime.BAIDU_MERGE_MAX_INDENT_RATIO);
  }
  runtime.shouldMergeBaiduWordItem = shouldMergeBaiduWordItem;
  function mergeBaiduWordItems(items, imageSize) {
    const boxes = items.map(item => runtime.getBaiduItemBox(item)).filter(Boolean);
    if (boxes.length === 0) {
      return null;
    }
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
    return {
      words: runtime.composeBaiduMergedWords(items),
      location,
      confidence: Math.max(...items.map(item => Number(item.confidence || 0))),
      ...runtime.summarizeOcrConfidence(items),
      rawBox: location
    };
  }
  runtime.mergeBaiduWordItems = mergeBaiduWordItems;
  function composeBaiduMergedWords(items) {
    const rows = [];
    const sorted = items.filter(item => item && String(item.words || "").trim()).sort(runtime.compareBaiduWordItems);
    sorted.forEach(item => {
      const box = runtime.getBaiduItemBox(item);
      const text = String(item.words || "").trim();
      if (!box || !text) {
        return;
      }
      const row = rows.find(candidate => {
        const overlap = Math.min(candidate.bottom, box.bottom) - Math.max(candidate.top, box.top);
        return overlap >= Math.min(candidate.height, box.height) * 0.45;
      });
      if (row) {
        row.items.push({
          item,
          box,
          text
        });
        row.top = Math.min(row.top, box.top);
        row.bottom = Math.max(row.bottom, box.bottom);
        row.height = Math.max(1, row.bottom - row.top);
      } else {
        rows.push({
          top: box.top,
          bottom: box.bottom,
          height: box.height,
          items: [{
            item,
            box,
            text
          }]
        });
      }
    });
    return rows.sort((left, right) => left.top - right.top).map(row => row.items.sort((left, right) => left.box.left - right.box.left).map(entry => entry.text).join(" ")).filter(Boolean).join("\n");
  }
  runtime.composeBaiduMergedWords = composeBaiduMergedWords;
  function expandBaiduMergedLocation(location, boxes, imageSize) {
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const avgHeight = Math.max(1, boxes.reduce((sum, box) => sum + box.height, 0) / Math.max(1, boxes.length));
    const marginX = Math.max(3, Math.min(location.width * 0.1, avgHeight * 0.6));
    const marginY = Math.max(3, Math.min(location.height * 0.1, avgHeight * 0.5));
    const left = runtime.clamp(location.left - marginX, 0, imageWidth);
    const top = runtime.clamp(location.top - marginY, 0, imageHeight);
    const right = runtime.clamp(location.left + location.width + marginX, left + 1, imageWidth);
    const bottom = runtime.clamp(location.top + location.height + marginY, top + 1, imageHeight);
    return {
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    };
  }
  runtime.expandBaiduMergedLocation = expandBaiduMergedLocation;
  function getBaiduGroupBox(group) {
    const boxes = group.map(item => runtime.getBaiduItemBox(item)).filter(Boolean);
    if (boxes.length === 0) {
      return null;
    }
    const left = Math.min(...boxes.map(box => box.left));
    const top = Math.min(...boxes.map(box => box.top));
    const right = Math.max(...boxes.map(box => box.right));
    const bottom = Math.max(...boxes.map(box => box.bottom));
    return runtime.buildBaiduBox(left, top, right, bottom);
  }
  runtime.getBaiduGroupBox = getBaiduGroupBox;
  function getBaiduItemBox(item) {
    const location = item && item.location && typeof item.location === "object" ? item.location : null;
    if (!location) {
      return null;
    }
    const left = runtime.toNumber(location.left);
    const top = runtime.toNumber(location.top);
    const width = runtime.toNumber(location.width);
    const height = runtime.toNumber(location.height);
    if (!(width > 0 && height > 0)) {
      return null;
    }
    return runtime.buildBaiduBox(left, top, left + width, top + height);
  }
  runtime.getBaiduItemBox = getBaiduItemBox;
  function buildBaiduBox(left, top, right, bottom) {
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    return {
      left,
      top,
      right,
      bottom,
      width,
      height,
      centerX: left + width / 2,
      centerY: top + height / 2
    };
  }
  runtime.buildBaiduBox = buildBaiduBox;
  function getBaiduAverageHeight(items) {
    const boxes = items.map(item => runtime.getBaiduItemBox(item)).filter(Boolean);
    if (boxes.length === 0) {
      return 1;
    }
    return boxes.reduce((sum, box) => sum + box.height, 0) / boxes.length;
  }
  runtime.getBaiduAverageHeight = getBaiduAverageHeight;
}
