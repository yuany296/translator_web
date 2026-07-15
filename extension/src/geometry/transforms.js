export function applyHomography(matrix, point) {
  if (!Array.isArray(matrix) || matrix.length !== 9) throw new TypeError("Homography must contain 9 numbers");
  const x = Number(point?.x);
  const y = Number(point?.y);
  const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
  if (![x, y, denominator].every(Number.isFinite) || Math.abs(denominator) < 1e-9) {
    throw new Error("Point cannot be mapped by homography");
  }
  return Object.freeze({
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator
  });
}

export function mapPolygon(matrix, polygon) {
  return Object.freeze(polygon.map((point) => applyHomography(matrix, point)));
}

export function maximumRoundTripError(region) {
  return Math.max(...region.sourcePolygon.map((point) => {
    const crop = applyHomography(region.sourceToCrop, point);
    const restored = applyHomography(region.cropToSource, crop);
    return Math.hypot(restored.x - point.x, restored.y - point.y);
  }));
}

export function assertRoundTrip(region, tolerancePx = 1) {
  const error = maximumRoundTripError(region);
  if (error > tolerancePx) throw new Error(`Crop transform round-trip error ${error.toFixed(3)}px exceeds ${tolerancePx}px`);
  return error;
}
