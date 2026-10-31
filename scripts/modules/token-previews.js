const PREVIEW_KEYS = ["_preview", "preview", "_dragPreview", "_movementPreview", "_previewObject"];

function familyKey(token) {
  const original = token?._original ?? token;
  return original?.document?.uuid ?? original?.document?.id ?? original;
}

// Build once per update/sort batch: scanning a shared preview container for
// each member of a group turned group dragging into quadratic work.
export function buildTokenPreviewIndex(tokens, isTokenObject) {
  const index = new Map();
  const seen = new Set();
  const visit = value => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (isTokenObject(value)) {
      if (value.destroyed) return;
      const parent = value.document?.parent;
      if (parent && parent !== globalThis.canvas?.scene) return;
      const key = familyKey(value);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(value);
    } else if (Array.isArray(value) || value instanceof Set) {
      for (const entry of value) visit(entry);
    } else if (value instanceof Map) {
      for (const entry of value.values()) visit(entry);
    } else {
      for (const key of ["children", "placeables", "objects"]) {
        if (Array.isArray(value[key])) visit(value[key]);
      }
    }
  };
  const layers = new Set([globalThis.canvas?.tokens]);
  for (const token of tokens) {
    visit(token);
    if (token?.layer) layers.add(token.layer);
    for (const key of PREVIEW_KEYS) {
      try { visit(token?.[key]); } catch (_err) { /* Private access can throw. */ }
    }
  }
  for (const layer of layers) {
    for (const source of [layer?.preview, layer?._preview, layer?.previews, layer?._previews, layer?.objects?.preview]) visit(source);
  }
  return index;
}

export function getIndexedTokenPreviews(token, index) {
  return index.get(familyKey(token)) ?? [];
}
