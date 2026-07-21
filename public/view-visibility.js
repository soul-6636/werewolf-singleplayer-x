export function isNightPhase(phase) {
  return typeof phase === "string" && phase.startsWith("night_");
}

export function visiblePhaseForPlayer(phase, role) {
  if (!isNightPhase(phase)) return phase;
  const rolePhase = { werewolf: "night_wolf", witch: "night_witch", seer: "night_seer" }[role];
  return phase === rolePhase ? phase : "night";
}

export function canExposeActiveActor({ phase, debugMode = false, activePlayerId = null } = {}) {
  if (!activePlayerId) return false;
  return Boolean(debugMode) || !isNightPhase(phase);
}

export function publicWaitingText({ phase, activePlayerLabel = "" } = {}) {
  if (isNightPhase(phase)) return "夜间行动进行中";
  return activePlayerLabel ? `${activePlayerLabel}正在行动` : "规则引擎正在推进阶段";
}
