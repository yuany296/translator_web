export function applyDomTextLayer(node, layer) {
  if (layer.type !== "text" || layer.layout?.status !== "ready") return false;
  const { placement, lines, fontSize, lineHeight } = layer.layout;
  node.textContent = lines.join("\n");
  Object.assign(node.style, {
    position: "absolute",
    left: `${placement.center.x}px`,
    top: `${placement.center.y}px`,
    width: `${placement.writingMode === "vertical" ? placement.normalThickness : placement.axisLength}px`,
    height: `${placement.writingMode === "vertical" ? placement.axisLength : placement.normalThickness}px`,
    fontSize: `${fontSize}px`,
    lineHeight: `${lineHeight}px`,
    whiteSpace: "pre-line",
    transformOrigin: "center center",
    transform: `translate(-50%, -50%) rotate(${placement.rotationDeg}deg)`,
    writingMode: placement.writingMode === "vertical" ? "vertical-rl" : "horizontal-tb",
    overflow: "hidden"
  });
  return true;
}

export function renderDomScene(scene, adapter) {
  const nodes = [];
  for (const layer of scene.layers) {
    if (!layer.active) continue;
    if (layer.type === "cover") nodes.push(adapter.drawCover(layer));
    if (layer.type === "text") {
      const node = adapter.createTextNode(layer);
      if (node && applyDomTextLayer(node, layer)) nodes.push(node);
    }
    if (layer.type === "debug") nodes.push(adapter.drawDebug(layer));
    if (layer.type === "loading") nodes.push(adapter.drawLoading(layer));
  }
  return nodes.filter(Boolean);
}
