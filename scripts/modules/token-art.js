const PORTRAITS_MODULE_ID = "ginzzzu-portraits";
const HEIGHT_FLAGS = ["portraitHeightMultiplier", "emotionHeightMultiplier"];

function readMultiplier(actor, key) {
  const raw = actor.getFlag?.(PORTRAITS_MODULE_ID, key)
    ?? actor.flags?.[PORTRAITS_MODULE_ID]?.[key];
  if ((typeof raw !== "number" && typeof raw !== "string") || (typeof raw === "string" && !raw.trim())) return 1;
  const multiplier = Number(raw);
  return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 1;
}

export function getTokenArtMultiplier(token) {
  if (!globalThis.game?.modules?.get?.(PORTRAITS_MODULE_ID)?.active) return 1;
  const actor = token?.actor ?? token?.document?.actor ?? token?._original?.actor;
  if (!actor) return 1;
  // Match the portrait HUD: the active emotion scales the actor's base height.
  const multiplier = readMultiplier(actor, HEIGHT_FLAGS[0]) * readMultiplier(actor, HEIGHT_FLAGS[1]);
  return Number.isFinite(multiplier) ? multiplier : 1;
}

function touchesPath(changes, path) {
  if (!changes || typeof changes !== "object") return true;
  const parts = path.split(".");
  for (let length = 1; length <= parts.length; length++) {
    const prefix = parts.slice(0, length).join(".");
    const deletion = [...parts.slice(0, length - 1), `-=${parts[length - 1]}`].join(".");
    if (Object.hasOwn(changes, deletion)) return true;
    if (!Object.hasOwn(changes, prefix)) continue;
    if (length === parts.length || touchesPath(changes[prefix], parts.slice(length).join("."))) return true;
  }
  return false;
}

export function isTokenArtMultiplierUpdate(changes = {}) {
  if (!changes || typeof changes !== "object") return false;
  return HEIGHT_FLAGS.some(key => touchesPath(changes, `flags.${PORTRAITS_MODULE_ID}.${key}`));
}
