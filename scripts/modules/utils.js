export function i18n(key) {
  return globalThis.game?.i18n?.localize?.(key) ?? key;
}

export function clamp(value, min, max) {
  value = Number(value);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function asBool(value) {
  if (Array.isArray(value)) return value.length ? asBool(value[value.length - 1]) : false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return Boolean(value);
}

export function parseColor(value, fallback = 0xffffff) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const text = String(value ?? "").trim();
  if (!text) return fallback;

  const hex = text.startsWith("#") ? text.slice(1) : text.replace(/^0x/i, "");
  const expanded = hex.length === 3
    ? hex.split("").map(char => `${char}${char}`).join("")
    : hex;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return fallback;
  const parsed = Number.parseInt(expanded, 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function safeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try { return Array.from(value); }
  catch (_err) { return []; }
}
