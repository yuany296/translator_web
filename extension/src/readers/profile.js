import { resolveSiteHint } from "./site-hints.js";

function visibleMedia(documentValue) {
  return [...documentValue.querySelectorAll("img,canvas")].filter((node) => {
    const rect = node.getBoundingClientRect?.();
    return rect && rect.width >= 80 && rect.height >= 40;
  });
}

export function detectReaderProfile(documentValue = globalThis.document, locationValue = globalThis.location) {
  documentValue ||= { querySelectorAll: () => [], querySelector: () => null };
  const hint = resolveSiteHint(locationValue);
  const media = visibleMedia(documentValue);
  const canvasCount = media.filter((node) => node.tagName === "CANVAS").length;
  const verticalPairs = media.slice(1).filter((node, index) => {
    const previous = media[index].getBoundingClientRect();
    const current = node.getBoundingClientRect();
    return current.top >= previous.top && Math.abs(current.left - previous.left) < Math.max(40, previous.width * 0.2);
  }).length;
  let type = "independent-media";
  if (canvasCount > Math.max(0, media.length / 2)) type = "canvas-reader";
  else if (media.length >= 3 && verticalPairs >= media.length - 2) type = "continuous-strip";
  else if (documentValue.querySelector("[data-virtualized], [style*='translate3d'], [style*='translateY']")) type = "virtualized-strip";
  if (hint.weight >= 2 && type === "independent-media") type = hint.profile;
  return Object.freeze({
    type, siteHint: hint.id, targetSelector: hint.selector,
    scrollDirection: type === "continuous-strip" || type === "virtualized-strip" ? "vertical" : "unknown",
    virtualized: type === "virtualized-strip"
  });
}
