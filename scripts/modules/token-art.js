const PORTRAITS_MODULE_ID = "ginzzzu-portraits";

export function getTokenArtMultiplier(token) {
  if (!globalThis.game?.modules?.get?.(PORTRAITS_MODULE_ID)?.active) return 1;
  const actor = token?.actor ?? token?.document?.actor ?? token?._original?.actor;
  if (!actor) return 1;
  const raw = actor.getFlag?.(PORTRAITS_MODULE_ID, "portraitHeightMultiplier")
    ?? actor.flags?.[PORTRAITS_MODULE_ID]?.portraitHeightMultiplier;
  if ((typeof raw !== "number" && typeof raw !== "string") || (typeof raw === "string" && !raw.trim())) return 1;
  const multiplier = Number(raw);
  return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 1;
}

export function isTokenArtMultiplierUpdate(changes = {}) {
  return Boolean(changes.flags?.[PORTRAITS_MODULE_ID])
    || Object.keys(changes).some(key => key.startsWith(`flags.${PORTRAITS_MODULE_ID}.`));
}
