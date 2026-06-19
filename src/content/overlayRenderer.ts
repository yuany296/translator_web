import { fitTextToBox } from "../core/layout/textFit";
import type { BoundingBox, ExtensionSettings, ImageCandidate, OCRTranslateResult, TranslationUnit } from "../core/types";

const OVERLAY_LAYER_ID = "manga-image-translator-overlay-layer";

interface OverlayState {
  candidate: ImageCandidate;
  result: OCRTranslateResult;
  root: HTMLElement;
  settings: ExtensionSettings;
}

const overlayStates = new Map<string, OverlayState>();
let syncListenersInstalled = false;
let syncFrame = 0;

export function renderDebugBoxes(candidates: ImageCandidate[]): void {
  const layer = ensureLayer();
  clearByClass(layer, "mit-debug-box");
  for (const candidate of candidates) {
    const node = document.createElement("div");
    node.className = "mit-debug-box";
    node.textContent = candidate.kind;
    placeNode(node, candidate.rect);
    layer.appendChild(node);
  }
}

export function clearDebugBoxes(): void {
  clearByClass(ensureLayer(), "mit-debug-box");
}

export function renderOverlayResult(
  candidate: ImageCandidate,
  result: OCRTranslateResult,
  settings: ExtensionSettings
): void {
  const layer = ensureLayer();
  ensureSyncListeners();
  removeOverlay(candidate.targetKey);
  const root = document.createElement("div");
  root.className = "mit-translation-root";
  root.dataset.targetKey = candidate.targetKey;

  result.translations.forEach((translation, index) => {
    const bubble = createTranslationNode(translation, result, candidate, settings);
    root.appendChild(bubble);
    if (settings.debugMode) {
      root.appendChild(createOverlayDebugNode("overlay", index, translation.blockId));
    }
  });

  if (settings.debugMode) {
    result.ocrResults.forEach((item, index) => {
      root.appendChild(createOverlayDebugNode("ocr", index, item.text));
    });
    result.blocks.forEach((block, index) => {
      root.appendChild(createOverlayDebugNode("block", index, block.id));
    });
  }

  layer.appendChild(root);
  const overlayState = { candidate, result, root, settings };
  overlayStates.set(candidate.targetKey, overlayState);
  syncOverlayPosition(overlayState);
  logOverlayDebug(overlayState);
}

export function setOverlayVisible(visible: boolean): void {
  ensureLayer().style.display = visible ? "block" : "none";
}

export function removeOverlay(targetKey: string): void {
  const layer = ensureLayer();
  layer.querySelectorAll(`[data-target-key="${cssEscape(targetKey)}"]`).forEach((node) => node.remove());
  overlayStates.delete(targetKey);
}

function createTranslationNode(
  translation: TranslationUnit,
  _result: OCRTranslateResult,
  _candidate: ImageCandidate,
  _settings: ExtensionSettings
): HTMLElement {
  const node = document.createElement("div");
  node.className = "mit-translation-bubble";
  node.dataset.blockId = translation.blockId;
  node.setAttribute("role", "button");
  node.setAttribute("tabindex", "0");
  node.title = "Click to switch between original image and translation overlay";
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSourceMode(node);
  });
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleSourceMode(node);
    }
  });
  return node;
}

function syncOverlayPosition(state: OverlayState): void {
  const rect = getLivePageRect(state.candidate);
  placeNode(state.root, rect);
  const scaleX = rect.width / Math.max(1, state.result.image.width);
  const scaleY = rect.height / Math.max(1, state.result.image.height);

  state.result.translations.forEach((translation, index) => {
    const node = state.root.querySelector<HTMLElement>(`.mit-translation-bubble[data-block-id="${cssEscape(translation.blockId)}"]`);
    if (!node) {
      return;
    }
    const overlayRect = scaleBox(translation.boundingBox, scaleX, scaleY);
    placeNode(node, overlayRect);
    applyBubbleText(node, translation, overlayRect, state);
    node.classList.toggle("mit-translation-bubble-effect", isEffectLike(translation, state.result.image));
    node.classList.toggle("mit-translation-bubble-dialogue", !isEffectLike(translation, state.result.image));
    syncDebugNode(state.root, "overlay", index, overlayRect);
  });

  if (state.settings.debugMode) {
    state.result.ocrResults.forEach((item, index) => {
      syncDebugNode(state.root, "ocr", index, scaleBox(item.boundingBox, scaleX, scaleY));
    });
    state.result.blocks.forEach((block, index) => {
      syncDebugNode(state.root, "block", index, scaleBox(block.boundingBox, scaleX, scaleY));
    });
  }
}

function applyBubbleText(
  node: HTMLElement,
  translation: TranslationUnit,
  rect: BoundingBox,
  state: OverlayState
): void {
  const text = translation.translatedText.trim() || translation.sourceText.trim();
  const paddingX = clampNumber(rect.width * 0.07, 4, 14);
  const paddingY = clampNumber(rect.height * 0.08, 3, 12);
  const innerWidth = Math.max(1, rect.width - paddingX * 2);
  const innerHeight = Math.max(1, rect.height - paddingY * 2);
  const maxFontSize = Math.round(
    clampNumber(Math.max(state.settings.font.fontSize, Math.min(rect.width * 0.28, rect.height * 0.56)), 12, 54)
  );
  const minFontSize = Math.round(clampNumber(Math.min(state.settings.font.fontSize, Math.max(10, rect.height * 0.18)), 10, 18));
  const fit = fitTextToBox(text, {
    minFontSize,
    maxFontSize,
    width: innerWidth,
    height: innerHeight
  });
  node.style.padding = `${paddingY}px ${paddingX}px`;
  node.style.color = state.settings.font.fontColor;
  node.style.fontSize = `${fit.fontSize}px`;
  node.style.setProperty("--mit-stroke-color", state.settings.font.strokeColor);
  node.style.setProperty("--mit-stroke-width", `${state.settings.font.strokeWidth}px`);
  node.style.setProperty("--mit-overlay-bg", withOpacity(state.settings.font.backgroundColor, state.settings.font.backgroundOpacity));
  node.dataset.fontSize = String(fit.fontSize);
  node.textContent = fit.lines.join("\n");
}

function createOverlayDebugNode(kind: "ocr" | "block" | "overlay", index: number, label: string): HTMLElement {
  const node = document.createElement("div");
  node.className = `mit-overlay-debug mit-overlay-debug-${kind}`;
  node.dataset.debugKind = kind;
  node.dataset.debugIndex = String(index);
  node.textContent = `${kind}:${label}`;
  return node;
}

function syncDebugNode(root: HTMLElement, kind: "ocr" | "block" | "overlay", index: number, rect: BoundingBox): void {
  const node = root.querySelector<HTMLElement>(`.mit-overlay-debug[data-debug-kind="${kind}"][data-debug-index="${index}"]`);
  if (node) {
    placeNode(node, rect);
  }
}

function toggleSourceMode(node: HTMLElement): void {
  const root = node.closest<HTMLElement>(".mit-translation-root");
  if (root) {
    root.classList.toggle("mit-show-source");
  }
}

function getLivePageRect(candidate: ImageCandidate): BoundingBox {
  const element = findTargetElement(candidate.targetKey);
  if (!element) {
    return candidate.rect;
  }
  const rect = element.getBoundingClientRect();
  const pageRect = {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height
  };
  candidate.rect = pageRect;
  return pageRect;
}

function findTargetElement(targetKey: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-mit-target-id="${cssEscape(targetKey)}"]`);
}

function scaleBox(box: BoundingBox, scaleX: number, scaleY: number): BoundingBox {
  return {
    x: box.x * scaleX,
    y: box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY
  };
}

function isEffectLike(translation: TranslationUnit, image: { width: number; height: number }): boolean {
  const areaRatio =
    (translation.sourceBoundingBox.width * translation.sourceBoundingBox.height) / Math.max(1, image.width * image.height);
  const longSideRatio =
    Math.max(translation.sourceBoundingBox.width / Math.max(1, image.width), translation.sourceBoundingBox.height / Math.max(1, image.height));
  const compactSource = translation.sourceText.replace(/\s+/g, "");
  return areaRatio >= 0.018 || longSideRatio >= 0.22 || (compactSource.length <= 8 && longSideRatio >= 0.12);
}

function ensureSyncListeners(): void {
  if (syncListenersInstalled) {
    return;
  }
  syncListenersInstalled = true;
  window.addEventListener("scroll", scheduleSyncAllOverlays, true);
  window.addEventListener("resize", scheduleSyncAllOverlays);
}

function scheduleSyncAllOverlays(): void {
  if (syncFrame) {
    return;
  }
  syncFrame = window.requestAnimationFrame(() => {
    syncFrame = 0;
    overlayStates.forEach((state) => syncOverlayPosition(state));
  });
}

function logOverlayDebug(state: OverlayState): void {
  if (!state.settings.debugMode) {
    return;
  }
  const scaleX = state.candidate.rect.width / Math.max(1, state.result.image.width);
  const scaleY = state.candidate.rect.height / Math.max(1, state.result.image.height);
  console.groupCollapsed(`[MangaTranslator] overlay blocks: ${state.candidate.targetKey}`);
  console.table(
    state.result.translations.map((translation) => ({
      blockId: translation.blockId,
      sourceText: translation.sourceText,
      translatedText: translation.translatedText,
      sourceBox: JSON.stringify(roundBox(translation.sourceBoundingBox)),
      overlayBox: JSON.stringify(roundBox(translation.boundingBox)),
      pageOverlay: JSON.stringify(roundBox(scaleBox(translation.boundingBox, scaleX, scaleY))),
      fontSize: state.root.querySelector<HTMLElement>(`.mit-translation-bubble[data-block-id="${cssEscape(translation.blockId)}"]`)
        ?.dataset.fontSize
    }))
  );
  console.groupEnd();
}

function ensureLayer(): HTMLElement {
  const existing = document.getElementById(OVERLAY_LAYER_ID);
  if (existing) {
    return existing;
  }
  const layer = document.createElement("div");
  layer.id = OVERLAY_LAYER_ID;
  document.documentElement.appendChild(layer);
  return layer;
}

function clearByClass(layer: HTMLElement, className: string): void {
  layer.querySelectorAll(`.${className}`).forEach((node) => node.remove());
}

function placeNode(node: HTMLElement, rect: { x: number; y: number; width: number; height: number }): void {
  node.style.left = `${rect.x}px`;
  node.style.top = `${rect.y}px`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

function roundBox(box: BoundingBox): BoundingBox {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height)
  };
}

function withOpacity(hex: string, opacity: number): string {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) {
    return `rgba(255,255,255,${opacity})`;
  }
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${Math.max(0, Math.min(1, opacity))})`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}
