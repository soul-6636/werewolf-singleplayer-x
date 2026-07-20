const WOLF = "werewolf";
const VILLAGER = "villager";
const GODS = new Set(["seer", "witch"]);

function alivePlayers(players = []) {
  return players.filter((player) => player?.alive !== false);
}

export function getWinner(players = []) {
  const alive = alivePlayers(players);
  const wolves = alive.filter((player) => player.role === WOLF).length;
  const villagers = alive.filter((player) => player.role === VILLAGER).length;
  const gods = alive.filter((player) => GODS.has(player.role)).length;
  if (wolves === 0) return "village";
  if (villagers === 0 || gods === 0) return "werewolf";
  return null;
}

export function getSituationMetrics(players = []) {
  const alive = alivePlayers(players);
  const wolves = alive.filter((player) => player.role === WOLF).length;
  const villagers = alive.filter((player) => player.role === VILLAGER).length;
  const gods = alive.filter((player) => GODS.has(player.role)).length;
  return {
    alive: alive.length,
    wolves,
    villagers,
    gods,
    wolfWinDistance: Math.min(villagers, gods),
    villageWinDistance: wolves,
    winner: getWinner(players)
  };
}

function copyPlayers(players) {
  return players.map((player) => ({ ...player }));
}

function kill(players, playerId) {
  if (!playerId) return;
  const target = players.find((player) => player.id === playerId && player.alive !== false);
  if (target) target.alive = false;
}

function resolveNight(players, night = {}, witch = {}, action = {}) {
  const saved = action.action === "save" && witch.saveAvailable && action.targetId === night.wolfTarget;
  if (!saved) kill(players, night.wolfTarget);
  if (action.action === "poison" && witch.poisonAvailable) kill(players, action.targetId);
}

export function simulateLegalBranch({ players = [], phase = "", night = {}, witch = {}, action = {} } = {}) {
  const nextPlayers = copyPlayers(players);
  if (["vote", "vote_retry"].includes(phase) && action.targetId && action.targetId !== "ABSTAIN") {
    kill(nextPlayers, action.targetId);
  }
  if (phase === "night_resolve" || phase === "night_witch") {
    resolveNight(nextPlayers, night, witch, action);
  }
  const metrics = getSituationMetrics(nextPlayers);
  return {
    action: { ...action },
    players: nextPlayers,
    ...metrics
  };
}

export function enumerateLegalBranches({ players = [], phase = "", night = {}, witch = {}, legalActions = [] } = {}) {
  return legalActions
    .filter((action) => action && typeof action === "object")
    .slice(0, 32)
    .map((action) => simulateLegalBranch({ players, phase, night, witch, action }));
}

export function evaluateSituation({ players = [], phase = "", day = 1, night = {}, witch = {}, legalActions = [] } = {}) {
  const metrics = getSituationMetrics(players);
  const branches = enumerateLegalBranches({ players, phase, night, witch, legalActions });
  const winningBranches = branches.filter((branch) => branch.winner);
  const recommendedBranch = branches
    .slice()
    .sort((left, right) => {
      const leftWinner = left.winner ? 1 : 0;
      const rightWinner = right.winner ? 1 : 0;
      if (leftWinner !== rightWinner) return leftWinner - rightWinner;
      return left.villageWinDistance + left.wolfWinDistance - right.villageWinDistance - right.wolfWinDistance;
    })[0] || null;
  return {
    version: 1,
    day: Number(day) || 1,
    phase: String(phase),
    ...metrics,
    branchCount: branches.length,
    terminalBranchCount: winningBranches.length,
    branches,
    recommendedBranch
  };
}
