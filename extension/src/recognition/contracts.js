const freezePoints = (value, minimum = 4) => {
  if (!Array.isArray(value) || value.length < minimum) throw new TypeError("Text polygon is incomplete");
  return Object.freeze(value.map((point) => Object.freeze({ x: Number(point.x), y: Number(point.y) })));
};
const freezeMatrix = (value) => {
  if (!Array.isArray(value) || value.length !== 9 || value.some((entry) => !Number.isFinite(Number(entry)))) {
    throw new TypeError("Perspective transform must contain 9 finite numbers");
  }
  return Object.freeze(value.map(Number));
};
const box = (value) => Object.freeze({
  x: Number(value?.x ?? value?.left), y: Number(value?.y ?? value?.top),
  width: Number(value?.width ?? value?.w), height: Number(value?.height ?? value?.h)
});

export function createDetectedTextRegion(value) {
  const regionId = String(value?.regionId || "").trim();
  if (!regionId) throw new TypeError("DetectedTextRegion.regionId is required");
  const reliability = value.geometryReliability === "fallback" ? "fallback" : "detected";
  return Object.freeze({
    regionId,
    sourcePolygon: freezePoints(value.sourcePolygon),
    sourceBox: box(value.sourceBox),
    rotationDeg: Number(value.rotationDeg) || 0,
    cropSize: Object.freeze({ width: Number(value.cropSize?.width), height: Number(value.cropSize?.height) }),
    sourceToCrop: freezeMatrix(value.sourceToCrop),
    cropToSource: freezeMatrix(value.cropToSource),
    lineThickness: Math.max(1, Number(value.lineThickness) || 1),
    detectionScore: Math.min(1, Math.max(0, Number(value.detectionScore) || 0)),
    geometryReliability: reliability,
    fillBox: value.fillBox ? box(value.fillBox) : null,
    regionPolygon: value.regionPolygon ? freezePoints(value.regionPolygon) : null
  });
}

export function createRecognizedTextRegion(detectedRegion, value) {
  if (!detectedRegion?.regionId) throw new TypeError("Recognition must reference a detected region");
  return Object.freeze({
    regionId: detectedRegion.regionId,
    text: String(value?.text || "").trim(),
    confidence: Math.min(1, Math.max(0, Number(value?.confidence) || 0)),
    language: String(value?.language || "unknown"),
    appliedOrientation: Number(value?.appliedOrientation) || 0
  });
}

export function createSemanticTextBlock(value) {
  const ids = [...new Set((value?.memberRegionIds || []).map(String).filter(Boolean))];
  if (!value?.id || ids.length === 0) throw new TypeError("SemanticTextBlock requires id and members");
  return Object.freeze({
    id: String(value.id), memberRegionIds: Object.freeze(ids),
    originalText: String(value.originalText || "").trim(),
    readingOrder: Number(value.readingOrder) || 0,
    nonTranslate: value.nonTranslate === true
  });
}

export function applyVisionRepair(recognizedRegion, patch) {
  return Object.freeze({
    regionId: recognizedRegion.regionId,
    text: String(patch?.text || recognizedRegion.text).trim(),
    confidence: Math.min(1, Math.max(0, Number(patch?.confidence ?? recognizedRegion.confidence))),
    language: String(patch?.language || recognizedRegion.language),
    appliedOrientation: recognizedRegion.appliedOrientation
  });
}
