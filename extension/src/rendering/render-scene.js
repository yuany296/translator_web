export const LAYER_TYPES = Object.freeze({
  COVER: "cover", TEXT: "text", DEBUG: "debug", LOADING: "loading"
});

function immutableGeometry(value) {
  if (!value || typeof value !== "object") return null;
  return Object.freeze({ ...value });
}

export function createRenderLayer(value) {
  if (!Object.values(LAYER_TYPES).includes(value?.type)) throw new TypeError(`Unknown render layer type: ${value?.type}`);
  const id = String(value.id || "").trim();
  if (!id) throw new TypeError("Render layer id is required");
  if (value.type === LAYER_TYPES.TEXT && !value.layout) throw new TypeError("Text layer requires immutable layout");
  return Object.freeze({
    id, type: value.type, canonicalId: String(value.canonicalId || ""),
    active: value.active !== false, geometry: immutableGeometry(value.geometry),
    layout: value.layout || null, appearance: value.appearance ? Object.freeze({ ...value.appearance }) : null,
    diagnostic: value.diagnostic ? Object.freeze({ ...value.diagnostic }) : null
  });
}

export function createRenderScene({ id, surface, layers = [] }) {
  if (!surface || !["page", "composite"].includes(surface.type)) throw new TypeError("RenderScene needs page/composite surface");
  const result = [];
  const activeTextByFamily = new Set();
  for (const input of layers) {
    const layer = createRenderLayer(input);
    if (layer.type === LAYER_TYPES.TEXT && layer.active) {
      const family = String(input.regionFamily || layer.canonicalId || layer.id);
      if (activeTextByFamily.has(family)) continue;
      activeTextByFamily.add(family);
    }
    result.push(layer);
  }
  return Object.freeze({
    id: String(id || `${surface.type}:${surface.id}`),
    surface: Object.freeze({ ...surface }),
    layers: Object.freeze(result)
  });
}

export function sceneDiagnostics(scene) {
  return scene.layers.filter((layer) => layer.diagnostic).map((layer) => layer.diagnostic);
}
