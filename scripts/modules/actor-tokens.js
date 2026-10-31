// Foundry's actor index already scopes synthetic actors to their exact token.
// Only scan placeables as a fallback for systems without that API.
export function collectTokensForActor(actor) {
  const tokens = new Set();
  if (!actor || !globalThis.canvas?.ready) return tokens;
  try {
    const active = actor.getActiveTokens?.();
    if (Array.isArray(active)) {
      for (const token of active) if (token && !token.destroyed) tokens.add(token);
      return tokens;
    }
  } catch (_err) { /* Synthetic actors may be disappearing during scene teardown. */ }

  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (!token || token.destroyed) continue;
    const tokenActor = token.actor ?? token.document?.actor;
    if (tokenActor === actor) { tokens.add(token); continue; }
    if (actor.uuid && tokenActor?.uuid) {
      if (actor.uuid === tokenActor.uuid) tokens.add(token);
      continue;
    }
    // A synthetic actor must never fall back to a shared base actor ID.
    if (actor.isToken || tokenActor?.isToken) continue;
    const id = actor.id ?? actor._id;
    if (id && id === (tokenActor?.id ?? tokenActor?._id ?? token.document?.actorId)) tokens.add(token);
  }
  return tokens;
}
