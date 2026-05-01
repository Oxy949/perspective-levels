import { getSceneRect } from "./scene.js";

export function wrapPrototypeMethod(proto, methodName, wrapper) {
  const original = proto?.[methodName];
  if (typeof original !== "function" || original._perspectiveLevelsWrapped) return false;

  const wrapped = function perspectiveLevelsWrappedMethod(...args) {
    return wrapper.call(this, original, args);
  };
  wrapped._perspectiveLevelsWrapped = true;
  wrapped._perspectiveLevelsOriginal = original;
  proto[methodName] = wrapped;
  return true;
}

export function getTokenClass() {
  return globalThis.foundry?.canvas?.placeables?.Token
    ?? globalThis.CONFIG?.Token?.objectClass
    ?? globalThis.Token;
}

export function canUpdateTokenDocument(document) {
  const user = globalThis.game?.user;
  if (!document || !user) return false;
  if (user.isGM) return true;

  try {
    if (typeof document.canUserModify === "function") return Boolean(document.canUserModify(user, "update"));
  } catch (_err) { /* noop */ }

  try {
    if (typeof document.testUserPermission === "function") {
      return Boolean(document.testUserPermission(user, "OWNER"));
    }
  } catch (_err) { /* noop */ }

  return false;
}

function getKeyboardModifierConstants() {
  return globalThis.foundry?.helpers?.interaction?.KeyboardManager?.MODIFIER_KEYS
    ?? globalThis.KeyboardManager?.MODIFIER_KEYS
    ?? {};
}

export function isShiftActive(event = null) {
  const native = event?.nativeEvent ?? event?.originalEvent ?? event?.data?.originalEvent ?? event;
  if (native?.shiftKey === true) return true;

  try {
    const key = getKeyboardModifierConstants().SHIFT;
    if (key && globalThis.game?.keyboard?.isModifierActive?.(key)) return true;
  } catch (_err) { /* noop */ }

  try {
    if (globalThis.game?.keyboard?.isModifierActive?.("SHIFT")) return true;
  } catch (_err) { /* noop */ }

  try {
    if (globalThis.keyboard?.isDown?.("Shift") || globalThis.keyboard?.isDown?.("ShiftLeft") || globalThis.keyboard?.isDown?.("ShiftRight")) return true;
  } catch (_err) { /* noop */ }

  return false;
}

export function getKeyboardIncrementScale() {
  try {
    const key = getKeyboardModifierConstants().SHIFT;
    if (key && globalThis.game?.keyboard?.isModifierActive?.(key)) return 0.5;
  } catch (_err) { /* noop */ }

  try {
    if (globalThis.keyboard?.isDown?.("Shift")) return 0.5;
  } catch (_err) { /* noop */ }

  return 1;
}

export function getTokenIdentity(token) {
  return token?._original?.document?.id
    ?? token?.document?.id
    ?? token?._original?.id
    ?? token?.id
    ?? String(token);
}

export function getTokenPositionForFlight(token) {
  const source = token?._original ?? token;
  return {
    x: Number(token?.position?.x ?? token?.x ?? source?.position?.x ?? source?.x ?? token?.document?.x ?? source?.document?.x ?? 0) || 0,
    y: Number(token?.position?.y ?? token?.y ?? source?.position?.y ?? source?.y ?? token?.document?.y ?? source?.document?.y ?? 0) || 0
  };
}

export function getDocumentPixelSize(document, object, rect = getSceneRect()) {
  const width = Number(object?.w ?? object?.width ?? ((document?.width || 1) * rect.gridSize)) || rect.gridSize;
  const height = Number(object?.h ?? object?.height ?? ((document?.height || 1) * rect.gridSize)) || rect.gridSize;
  return { width, height };
}

export function getDocumentBottomPoint(document, object, rect = getSceneRect()) {
  const { width, height } = getDocumentPixelSize(document, object, rect);
  const x = Number(object?.position?.x ?? object?.x ?? document?.x ?? 0) || 0;
  const y = Number(object?.position?.y ?? object?.y ?? document?.y ?? 0) || 0;
  const elevation = Number(document?.elevation ?? object?.elevation ?? 0) || 0;
  return { x: x + (width / 2), y: y + height, elevation };
}
