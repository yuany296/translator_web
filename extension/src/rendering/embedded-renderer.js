export function renderEmbeddedScene(scene, context, adapter) {
  context.save();
  try {
    for (const layer of scene.layers) {
      if (!layer.active) continue;
      if (layer.type === "cover") adapter.drawCover(context, layer);
      if (layer.type !== "text" || layer.layout?.status !== "ready") continue;
      const { placement, lines, fontSize, lineHeight } = layer.layout;
      context.save();
      context.translate(placement.center.x, placement.center.y);
      context.rotate(placement.rotationDeg * Math.PI / 180);
      context.font = adapter.font(layer, fontSize);
      context.fillStyle = layer.appearance?.color || "#000000";
      if (placement.writingMode === "vertical" && typeof adapter.drawVerticalText === "function") {
        adapter.drawVerticalText(context, lines, layer);
      } else {
        const firstY = -((lines.length - 1) * lineHeight) / 2;
        lines.forEach((line, index) => adapter.drawText(context, line, 0, firstY + index * lineHeight, layer));
      }
      context.restore();
    }
  } finally {
    context.restore();
  }
}
