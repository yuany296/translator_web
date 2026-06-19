import type { ImageCandidate } from "../core/types";

const MIN_WIDTH = 120;
const MIN_HEIGHT = 120;

export interface ScannedTarget {
  element: HTMLElement | HTMLImageElement | HTMLCanvasElement;
  candidate: ImageCandidate;
}

export function scanMangaImages(root: ParentNode = document): ScannedTarget[] {
  const nodes = Array.from(root.querySelectorAll("img, canvas, [style*='background-image']"));
  const seen = new Set<string>();
  const results: ScannedTarget[] = [];

  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    const scanned = scanElement(node);
    if (!scanned || seen.has(scanned.candidate.targetKey)) {
      continue;
    }
    seen.add(scanned.candidate.targetKey);
    results.push(scanned);
  }
  return results;
}

export function scanElement(element: HTMLElement): ScannedTarget | null {
  const rect = element.getBoundingClientRect();
  if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) {
    return null;
  }

  if (element instanceof HTMLImageElement) {
    const sourceUrl = element.currentSrc || element.src || "";
    const naturalWidth = element.naturalWidth || Math.round(rect.width);
    const naturalHeight = element.naturalHeight || Math.round(rect.height);
    return buildTarget(element, "img", sourceUrl, naturalWidth, naturalHeight, rect);
  }

  if (element instanceof HTMLCanvasElement) {
    return buildTarget(element, "canvas", "", element.width || Math.round(rect.width), element.height || Math.round(rect.height), rect);
  }

  const backgroundUrl = extractBackgroundImageUrl(element);
  if (backgroundUrl) {
    return buildTarget(element, "background", backgroundUrl, Math.round(rect.width), Math.round(rect.height), rect);
  }

  return null;
}

export function getTargetKey(element: HTMLElement, sourceUrl: string): string {
  const existing = element.dataset.mitTargetId;
  if (existing) {
    return existing;
  }
  const key = `mit-${hashString(`${sourceUrl}|${element.tagName}|${Date.now()}|${Math.random()}`)}`;
  element.dataset.mitTargetId = key;
  return key;
}

function buildTarget(
  element: HTMLElement,
  kind: ImageCandidate["kind"],
  sourceUrl: string,
  naturalWidth: number,
  naturalHeight: number,
  rect: DOMRect
): ScannedTarget | null {
  const targetKey = getTargetKey(element, sourceUrl);
  return {
    element,
    candidate: {
      id: targetKey,
      kind,
      sourceUrl,
      targetKey,
      rect: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height
      },
      naturalWidth,
      naturalHeight,
      visible: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
    }
  };
}

function extractBackgroundImageUrl(element: HTMLElement): string {
  const backgroundImage = getComputedStyle(element).backgroundImage;
  const match = backgroundImage.match(/url\((["']?)(.*?)\1\)/);
  return match ? match[2] : "";
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
