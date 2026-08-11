export const DEFAULT_LANES = 3;
export const DEFAULT_BATCH_LIMITS = Object.freeze({
  0: { maxItems: 8, maxChars: 600 }, 1: { maxItems: 16, maxChars: 1200 },
  2: { maxItems: 32, maxChars: 2400 }, 3: { maxItems: 32, maxChars: 2400 }
});

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

export function getWebpageLanes(runtime) {
  const configured = Number(runtime?.state?.webpageConcurrency);
  return Number.isFinite(configured) ? clamp(configured, 1, 8) : DEFAULT_LANES;
}

export function getWebpageBatchLimits(runtime) {
  const configuredItems = Number(runtime?.state?.webpageBatchItems);
  const configuredChars = Number(runtime?.state?.webpageBatchChars);
  const baseItems = Number.isFinite(configuredItems) ? clamp(configuredItems, 4, 96) : DEFAULT_BATCH_LIMITS[2].maxItems;
  const baseChars = Number.isFinite(configuredChars) ? clamp(configuredChars, 400, 8000) : DEFAULT_BATCH_LIMITS[2].maxChars;
  return Object.freeze({
    0: { maxItems: Math.max(4, Math.floor(baseItems * 0.25)), maxChars: Math.max(400, Math.floor(baseChars * 0.25)) },
    1: { maxItems: Math.max(4, Math.floor(baseItems * 0.5)), maxChars: Math.max(400, Math.floor(baseChars * 0.5)) },
    2: { maxItems: baseItems, maxChars: baseChars },
    3: { maxItems: baseItems, maxChars: baseChars }
  });
}
