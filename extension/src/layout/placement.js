const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 1;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const normalizeAngle = (value) => {
  let angle = Number(value) || 0;
  while (angle > 90) angle -= 180;
  while (angle < -90) angle += 180;
  return angle;
};

export function buildPlacementGeometry(memberRegions, options = {}) {
  if (!Array.isArray(memberRegions) || memberRegions.length === 0) throw new TypeError("Placement needs detected members");
  const reliableAngles = memberRegions
    .filter((item) => item.geometryReliability !== "fallback")
    .map((item) => normalizeAngle(item.rotationDeg))
    .filter((angle) => Math.abs(angle) <= 25);
  const rotationDeg = reliableAngles.length ? median(reliableAngles) : 0;
  const radians = rotationDeg * Math.PI / 180;
  const axis = Object.freeze({ x: Math.cos(radians), y: Math.sin(radians) });
  const normal = Object.freeze({ x: -axis.y, y: axis.x });
  const memberPoints = memberRegions.flatMap((region) => region.sourcePolygon);
  const reliableRegion = options.bubbleRegion?.reliable === true ? options.bubbleRegion : null;
  const layoutPoints = reliableRegion?.polygon?.length >= 3 ? reliableRegion.polygon : memberPoints;
  const axisValues = layoutPoints.map((point) => point.x * axis.x + point.y * axis.y);
  const normalValues = layoutPoints.map((point) => point.x * normal.x + point.y * normal.y);
  const axisMin = Math.min(...axisValues);
  const axisMax = Math.max(...axisValues);
  const normalMin = Math.min(...normalValues);
  const normalMax = Math.max(...normalValues);
  const center = Object.freeze({
    x: axis.x * ((axisMin + axisMax) / 2) + normal.x * ((normalMin + normalMax) / 2),
    y: axis.y * ((axisMin + axisMax) / 2) + normal.y * ((normalMin + normalMax) / 2)
  });
  const fontHeight = Math.max(1, median(memberRegions.map((region) => Number(region.lineThickness))));
  return Object.freeze({
    id: String(options.id || memberRegions.map((item) => item.regionId).join("+")),
    memberRegionIds: Object.freeze(memberRegions.map((item) => item.regionId)),
    center, axis, normal, rotationDeg,
    axisLength: Math.max(1, axisMax - axisMin),
    normalThickness: Math.max(1, normalMax - normalMin),
    fontHeight,
    writingMode: options.writingMode === "vertical" ? "vertical" : "horizontal",
    boundary: reliableRegion ? Object.freeze({ type: "bubble", polygon: reliableRegion.polygon }) : Object.freeze({
      type: "oriented-union", axisMin, axisMax, normalMin, normalMax
    })
  });
}

export function groupPlacementRegions(memberRegions, angleToleranceDeg = 8) {
  const groups = [];
  for (const region of memberRegions || []) {
    const angle = normalizeAngle(region.rotationDeg);
    const group = groups.find((candidate) => Math.abs(normalizeAngle(candidate.angle - angle)) <= angleToleranceDeg);
    if (group) {
      group.members.push(region);
      group.angle = median(group.members.map((item) => normalizeAngle(item.rotationDeg)));
    } else groups.push({ angle, members: [region] });
  }
  return Object.freeze(groups.map((group) => Object.freeze([...group.members])));
}
