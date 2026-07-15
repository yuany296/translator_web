function wrapText(text, maxWidth, fontSize, measure) {
  const tokens = /\s/u.test(text) ? text.split(/(\s+)/u).filter(Boolean) : [...text];
  const lines = [];
  let line = "";
  for (const token of tokens) {
    const candidate = line + token;
    if (line && measure(candidate, fontSize) > maxWidth) {
      lines.push(line.trim());
      line = token.trimStart();
    } else line = candidate;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export function layoutInPlacement(textValue, placement, options = {}) {
  const text = String(textValue || "").trim();
  const measure = options.measure || ((value, size) => [...value].length * size);
  const minFontSize = Math.max(6, Number(options.minFontSize) || 10);
  const maxFontSize = Math.max(minFontSize, Math.min(placement.fontHeight, Number(options.maxFontSize) || placement.fontHeight));
  const padding = Math.max(0, Number(options.padding) || 0);
  const width = Math.max(1, placement.axisLength - padding * 2);
  const height = Math.max(1, placement.normalThickness - padding * 2);
  let low = minFontSize;
  let high = maxFontSize;
  let fitted = null;
  for (let step = 0; step < 10; step += 1) {
    const size = (low + high) / 2;
    const lines = wrapText(text, width, size, measure);
    const lineHeight = size * 1.18;
    if (lines.length * lineHeight <= height && lines.every((line) => measure(line, size) <= width)) {
      fitted = { lines, fontSize: size, lineHeight };
      low = size;
    } else high = size;
  }
  if (!fitted) return Object.freeze({ status: "layout_unfit", text, placement, diagnostics: "text_does_not_fit_minimum_size" });
  return Object.freeze({
    status: "ready", text, lines: Object.freeze(fitted.lines),
    fontSize: fitted.fontSize, lineHeight: fitted.lineHeight, placement
  });
}
