/**
 * OCR 调试叠层的渲染（raw / filtered / merged / final 各阶段的小方框与标签）。
 *
 * 从 `renderer-overlay.js` 拆出来：那支文件的职责是「把气泡画出来」，而这一整块只在
 * 「OCR 调试」打开时才跑（`localPaddle.debug` → 服务返回 debug 载荷 → 这里画框）。
 * 现场教训：这些 `raw-N [OCR 87.8%] | …` 标签看起来就是一行小字台词，用户看到满屏小字
 * 会问「日漫旁边这些是什么、为什么这么多」，所以画框之外必须再给一条自我说明横幅。
 */
export function installOcrDebugOverlay(runtime) {
  function formatOcrDebugConfidence(item) {
    const raw = item && item.raw;
    const candidates = [
      item && item.confidence,
      item && item.recognitionConfidence,
      item && item.recognition_confidence,
      item && item.recScore,
      item && item.rec_score,
      item && item.textScore,
      item && item.text_score,
      item && item.score,
      raw && (raw.confidence ?? raw.rec_score ?? raw.text_score ?? raw.score)
    ];
    const value = candidates.find(candidate => candidate !== null && candidate !== undefined && candidate !== "");
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return "";
    const count = Math.max(0, Math.round(Number(item && (item.confidenceCount ?? item.confidence_count)) || 0));
    const average = Number(item && (item.confidenceAverage ?? item.confidence_average));
    const minimum = Number(item && (item.confidenceMinimum ?? item.confidence_minimum));
    if (count > 1 && Number.isFinite(average) && Number.isFinite(minimum)) {
      const averagePercent = average <= 1 ? average * 100 : average;
      const minimumPercent = minimum <= 1 ? minimum * 100 : minimum;
      return `OCR avg ${averagePercent.toFixed(1)}% min ${minimumPercent.toFixed(1)}%`;
    }
    const percent = numeric <= 1 ? numeric * 100 : numeric;
    return `OCR ${percent.toFixed(1)}%`;
  }
  runtime.formatOcrDebugConfidence = formatOcrDebugConfidence;
  function createOcrDebugSvg() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "mt-debug-svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("data-manga-translator-overlay", "true");
    return svg;
  }
  runtime.createOcrDebugSvg = createOcrDebugSvg;
  function buildOcrDebugLabel(item, stage, index) {
    const blockId = String(item.blockId || item.block_id || item.id || `${stage.name}-${index}`);
    const original = String(item.text || item.originalText || "").replace(/\s+/g, " ").slice(0, 28);
    const translated = String(item.translatedText || item.translated_text || "").replace(/\s+/g, " ").slice(0, 28);
    const duplicate = item.isDuplicate ? " duplicate" : "";
    const confidence = formatOcrDebugConfidence(item);
    return `${blockId}${duplicate}${confidence ? ` [${confidence}]` : ""}${original ? ` | ${original}` : ""}${translated ? ` → ${translated}` : ""}`;
  }
  runtime.buildOcrDebugLabel = buildOcrDebugLabel;
  // 有 polygon 就画定向多边形 + 挂在其起点上的标签（跟随同一个旋转，竖排时不会压到邻列）；
  // 没有 polygon 退回轴对齐小方框。两者共用同一条 label 文案。
  function appendOcrDebugPolygonNode(root, svg, item, stage, label, debug) {
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("class", `mt-debug-poly ${stage.className} mt-debug-stage-${stage.name}`);
    poly.setAttribute("points", item.polygon.map(point => `${point.x},${point.y}`).join(" "));
    poly.setAttribute("data-manga-translator-overlay", "true");
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = label;
    poly.appendChild(title);
    svg.appendChild(poly);
    const labelDiv = document.createElement("div");
    labelDiv.className = `mt-debug-label ${stage.className} mt-debug-stage-${stage.name}`;
    labelDiv.dataset.label = label;
    labelDiv.dataset.mangaTranslatorOverlay = "true";
    labelDiv.style.left = `${item.polygon[0].x}%`;
    labelDiv.style.top = `${item.polygon[0].y}%`;
    labelDiv.style.transform = `rotate(${runtime.resolveBubblePolygonRotation(item.polygon, item.rotation_deg ?? item.rotationDeg, debug.imageWidth, debug.imageHeight)}deg)`;
    labelDiv.style.transformOrigin = "left bottom";
    root.appendChild(labelDiv);
  }
  runtime.appendOcrDebugPolygonNode = appendOcrDebugPolygonNode;
  function appendOcrDebugBoxNode(root, item, stage, label, debug) {
    const percent = runtime.getDebugItemPercent(item, debug);
    if (!percent) {
      return false;
    }
    const node = document.createElement("div");
    node.className = `mt-debug-box ${stage.className} mt-debug-stage-${stage.name}`;
    node.style.left = `${percent.x}%`;
    node.style.top = `${percent.y}%`;
    node.style.width = `${percent.w}%`;
    node.style.height = `${percent.h}%`;
    node.dataset.label = label;
    node.dataset.mangaTranslatorOverlay = "true";
    root.appendChild(node);
    return true;
  }
  runtime.appendOcrDebugBoxNode = appendOcrDebugBoxNode;
  function appendOcrDebugNodes(root, result) {
    const debug = result && result.debug;
    if (!debug || !root) {
      return 0;
    }
    let appended = 0;
    const stages = runtime.getRenderableOcrDebugStages(debug);
    const hasAnyPolygon = stages.some(stage =>
      (Array.isArray(stage.items) ? stage.items : []).some(item => Array.isArray(item && item.polygon))
    );
    let svg = hasAnyPolygon ? createOcrDebugSvg() : null;
    stages.forEach(stage => {
      (Array.isArray(stage.items) ? stage.items : []).forEach((item, index) => {
        const label = buildOcrDebugLabel(item, stage, index);
        if (Array.isArray(item.polygon) && item.polygon.length >= 4) {
          if (!svg) {
            svg = createOcrDebugSvg();
          }
          appendOcrDebugPolygonNode(root, svg, item, stage, label, debug);
        } else if (!appendOcrDebugBoxNode(root, item, stage, label, debug)) {
          return;
        }
        appended += 1;
      });
    });
    if (svg && svg.childElementCount > 0) {
      root.insertBefore(svg, root.firstChild);
    }
    if (appended > 0) {
      // 自我说明：满屏 raw=/block= 小字最难判断的就是「这是不是译文」。
      // 真机教训 —— 用户看着这些标签问「日漫旁边这些是什么、为什么这么多」，
      // 而它们只是识别中间结果（真正的原因是这个开关被打开了）。
      const badge = document.createElement("div");
      badge.className = "mt-debug-badge";
      badge.dataset.mangaTranslatorOverlay = "true";
      badge.textContent = "OCR 调试层：下面的 raw/block 标签是识别中间结果，不是译文 · 关闭：设置 → OCR 调试";
      root.appendChild(badge);
    }
    return appended;
  }
  runtime.appendOcrDebugNodes = appendOcrDebugNodes;
  function getDebugItemPercent(item, debug) {
    if (item && item.percent && [item.percent.x, item.percent.y, item.percent.w, item.percent.h].every(value => Number.isFinite(Number(value)))) {
      return item.percent;
    }
    const box = item && (item.rawBox || item.box);
    const imageWidth = Math.max(1, Number(debug && debug.imageWidth) || 1);
    const imageHeight = Math.max(1, Number(debug && debug.imageHeight) || 1);
    if (!box || ![box.left, box.top, box.width, box.height].every(value => Number.isFinite(Number(value)))) {
      return null;
    }
    return {
      x: Number(box.left) / imageWidth * 100,
      y: Number(box.top) / imageHeight * 100,
      w: Number(box.width) / imageWidth * 100,
      h: Number(box.height) / imageHeight * 100
    };
  }
  runtime.getDebugItemPercent = getDebugItemPercent;
}
