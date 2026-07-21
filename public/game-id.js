let fallbackSequence = 0;

export function createGameId(seed, nonce = null) {
  const safeSeed = Number.isInteger(Number(seed)) ? String(Number(seed)) : "0";
  let instance = String(nonce || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!instance) {
    instance = globalThis.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now().toString(36)}_${fallbackSequence += 1}`;
  }
  return `g_${safeSeed}_${instance}`.slice(0, 80);
}
