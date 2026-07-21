import {
  CLAIM_TYPES,
  COMMUNICATION_INTENTS,
  PRESSURE_LEVELS,
  addBeliefEvidence,
  addClaimNode,
  addClaimToMemory,
  appendPrivateEvent,
  appendPublicEvent,
  buildAgentContext,
  createAgentMemory,
  createClaimGraph,
  expireSecondOrderBeliefs,
  extractPublicSeerClaim,
  memoryPrompt,
  recordCommunication,
  recordDeception,
  reconcileMemoryDeceptions,
  isExplicitSeerClaim,
  isExplicitWitchClaim,
  sanitizePublicSpeech,
  validateGameState,
  validateReplayDocument,
  validatePublicSpeech,
  validatePublicSpeechEvidence,
  validateSeerSpeech,
  validateSpeechTargets,
  validateWitchSpeech,
  summarizeSimulationResults,
  setReasoningSummary,
  snapshotMemory
} from "./ai-core.js";
import { generateSpeechFromPlan, planStrategy, serializeStrategyPlan } from "./ai-strategy.js";
import { evaluateSituation } from "./ai-situation.js";
import { planDisclosure } from "./ai-disclosure.js";
import { canExposeActiveActor, publicWaitingText, visiblePhaseForPlayer } from "./view-visibility.js";
import { normalizeModelTarget, targetDiagnostic } from "./action-target.js";
import { matchesWolfBluffReport } from "./wolf-bluff.js";
import { validateWitchActionResources } from "./witch-action.js";
import { createGameId } from "./game-id.js";
import { buildDecisionPrompt, isDisclosureModeAllowed } from "./ai-prompt.js";
import { createGameRunCoordinator, isStaleGameRunError, StaleGameRunError } from "./game-run.js";
import {
  SPEECH_ACT_TYPES,
  claimsFromSpeechActs,
  normalizeSpeechActs,
  resolveSpeechDelivery,
  validateSpeechActs
} from "./speech-acts.js";

const ROLES = {
  werewolf: { name: "狼人", faction: "werewolf", side: "wolf", description: "夜晚与队友选择一名目标；白天隐藏身份。" },
  villager: { name: "平民", faction: "village", side: "villager", description: "没有夜间技能，通过发言和投票找出狼人。" },
  seer: { name: "预言家", faction: "village", side: "god", description: "每晚查验一名玩家，得知其阵营。" },
  witch: { name: "女巫", faction: "village", side: "god", description: "拥有一瓶解药和一瓶毒药，同一夜只能使用一种。" }
};

const PHASES = {
  night_wolf: ["NIGHT", "夜间行动", "夜色正浓", "所有人闭眼，等待夜间行动"],
  night_witch: ["NIGHT", "夜间行动", "夜色正浓", "所有人闭眼，等待夜间行动"],
  night_seer: ["NIGHT", "夜间行动", "夜色正浓", "所有人闭眼，等待夜间行动"],
  night_resolve: ["NIGHT", "夜晚结算", "无人知晓", "命运正在落定"],
  dawn: ["DAWN", "天亮了", "晨钟响起", "公布昨夜结果"],
  discussion: ["DAY", "白天发言", "所有人睁眼", "依次陈述与判断"],
  vote: ["VOTE", "放逐投票", "票型落定", "选择你怀疑的玩家"],
  vote_duel: ["DUEL", "决战台发言", "最后陈述", "并列玩家依次发言"],
  vote_retry: ["REVOTE", "平票重投", "再投一次", "只能从平票玩家中选择"],
  last_words: ["LAST WORDS", "放逐遗言", "留下最后一句话", "发言不能改变已经完成的放逐"],
  ended: ["END", "对局结束", "身份揭晓", "查看完整阵容"]
};

const BOT_NAMES = ["宁安", "江临", "周砚", "苏棠", "顾城"];
const PERSONAS = ["谨慎克制", "逻辑直接", "擅长观察", "容易怀疑", "温和但坚定"];
const ROLE_POOL = ["werewolf", "werewolf", "villager", "villager", "seer", "witch"];
const ABSTAIN = "ABSTAIN";
const MODEL_SETTINGS_KEY = "night-watch:model-settings:v1";
const APP_PREFERENCES_KEY = "night-watch:preferences:v1";
const DEFAULT_MODEL_SETTINGS = {
  dialect: "openai",
  baseUrl: "https://api.deepseek.com",
  endpointPath: "/chat/completions",
  model: "",
  apiKey: "",
  temperature: 0.7,
  reasoningEffort: "low"
};

const el = (id) => document.getElementById(id);
const lobbyScreen = el("lobby-screen");
const gameScreen = el("game-screen");
const tableStage = el("table-stage");
const timeline = el("timeline");
const actionContent = el("action-content");
const roleCard = el("role-card");
const settingsDialog = el("settings-dialog");
const developerPanel = el("developer-panel");

let game = null;
let pendingHuman = null;
let selectedTarget = null;
let advancing = false;
let speakingPlayerId = null;
let modelStatus = "本地引擎就绪";
let simulationMode = false;
let simulationRunning = false;
let lastInvariantSignature = "";
const gameRuns = createGameRunCoordinator();
let activeGameRun = null;

function captureGameOperation() {
  gameRuns.assertCurrent(activeGameRun);
  if (!game || game.id !== activeGameRun.gameId) throw new StaleGameRunError(activeGameRun?.gameId || null);
  return { run: activeGameRun, game };
}

function assertGameOperation(operation) {
  gameRuns.assertCurrent(operation?.run);
  if (!operation?.game || game !== operation.game || game.id !== operation.run.gameId) {
    throw new StaleGameRunError(operation?.run?.gameId || null);
  }
  return operation.game;
}

function loadStoredObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function saveStoredObject(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const storedModelSettings = loadStoredObject(MODEL_SETTINGS_KEY);
const modelSettings = { ...DEFAULT_MODEL_SETTINGS, ...storedModelSettings };
const appPreferences = { developerMode: false, ...loadStoredObject(APP_PREFERENCES_KEY) };

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createRng(seed) {
  let current = seed >>> 0;
  return () => {
    current = (current * 1664525 + 1013904223) >>> 0;
    return current / 4294967296;
  };
}

function shuffle(list, random) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function playerById(id) {
  return game?.players.find((player) => player.id === id);
}

function humanPlayer() {
  return game?.players.find((player) => player.controller === "human");
}

function alivePlayers() {
  return game.players.filter((player) => player.alive);
}

function seatLabel(playerId) {
  const player = playerById(playerId);
  return player ? `${player.seat + 1} 号` : "未知座位";
}

function addEvent(kind, actor, text) {
  const event = { id: game.nextEventId++, day: game.day, kind, actor, text };
  game.events.push(event);
  if (!simulationMode) {
    void fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameId: game.id,
        sequence: event.id,
        type: event.kind,
        visibility: "PUBLIC",
        payload: { day: event.day, actor: event.actor, text: event.text }
      })
    }).catch(() => {});
  }
  for (const player of game.players) {
    if (player.alive) appendPublicEvent(game.agentMemories[player.id], event);
  }
  renderTimeline();
  return event;
}

function addPrivateMemoryEvent(playerId, text, kind = "private") {
  const event = { id: `${kind}_${game.nextPrivateEventId++}_${playerId}`, day: game.day, kind, text };
  appendPrivateEvent(game.agentMemories[playerId], event);
  if (playerId === humanPlayer()?.id) game.privateEvents.push({ day: game.day, text });
}

function recordErrorLog({ source = "runtime", error, playerId = null, kind = null, diagnostic = "" } = {}) {
  if (!game) return;
  const message = String(error?.message || error || "未知错误").trim().slice(0, 500);
  const stack = String(error?.stack || "").trim().slice(0, 1200);
  const safeDiagnostic = String(diagnostic || error?.diagnostic || "").trim().slice(0, 500);
  const at = new Date().toISOString();
  game.errorLog ||= [];
  game.errorLog.push({
    id: game.nextErrorId++,
    at,
    day: game.day,
    phase: game.phase,
    source,
    playerId,
    kind,
    message,
    diagnostic: safeDiagnostic,
    stack
  });
  if (game.errorLog.length > 50) game.errorLog.shift();
  if (!simulationMode) {
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ at, day: game.day, phase: game.phase, source, playerId, kind, message, diagnostic: safeDiagnostic, stack })
    }).then(async (response) => {
      if (response.ok) return;
      let payload = {};
      try { payload = await response.json(); } catch {}
      throw new Error(payload.error || `公开事件写入失败（${response.status}）`);
    }).catch((error) => recordErrorLog({ source: "event-store", error }));
  }
}

function addWolfMemoryEvent(text, speakerId = null) {
  for (const player of game.players.filter((item) => item.alive && item.role === "werewolf")) {
    addPrivateMemoryEvent(player.id, text, "wolf-room");
  }
  if (speakerId) {
    const memory = game.agentMemories[speakerId];
    if (memory) memory.lastWolfSpeakerId = speakerId;
  }
}

function recordWitchNightMemory(witchId) {
  const action = game.night.witchAction || { action: "pass" };
  const kill = game.night.wolfTarget ? seatLabel(game.night.wolfTarget) : "无";
  const inventory = `解药${game.witch.saveAvailable ? "可用" : "已用"}、毒药${game.witch.poisonAvailable ? "可用" : "已用"}`;
  addPrivateMemoryEvent(witchId, `本夜狼刀目标：${kill}；你的选择：${action.action}；${inventory}。`, "witch-night");
}

function setPhase(phase) {
  if (game.ended && phase !== "ended") {
    game.invariantErrors = [...new Set([...(game.invariantErrors || []), "结束状态尝试迁移到非结束阶段"])]
  }
  game.phase = phase;
  game.phaseHistory.push({ day: game.day, phase });
  render();
}

function buildRoles(roleMode, random) {
  if (roleMode === "random") return shuffle(ROLE_POOL, random);
  const index = ROLE_POOL.indexOf(roleMode);
  const remaining = ROLE_POOL.filter((_, roleIndex) => roleIndex !== index);
  return [roleMode, ...shuffle(remaining, random)];
}

function createGame(playerName, roleMode, onlineAI, developerMode, seedOverride = null) {
  const parsedSeed = Number(seedOverride);
  const seed = Number.isInteger(parsedSeed) && parsedSeed > 0 && parsedSeed < 2147483647
    ? parsedSeed
    : Date.now() % 2147483647;
  const random = createRng(seed);
  const roles = buildRoles(roleMode, random);
  const names = [playerName || "你", ...BOT_NAMES];
  const roster = names.map((name, index) => ({
    id: `P${index + 1}`,
    name,
    role: roles[index],
    alive: true,
    controller: index === 0 ? "human" : "ai",
    persona: PERSONAS[Math.max(0, index - 1)] || "沉着"
  }));
  const seatedPlayers = shuffle(roster, random).map((player, seat) => ({ ...player, seat }));
  const gameId = createGameId(seed);
  return {
    id: gameId,
    seed,
    random,
    day: 1,
    phase: "night_wolf",
    players: seatedPlayers,
    events: [],
    privateEvents: [],
    publicClaims: [],
    claimGraph: createClaimGraph(),
    agentMemories: Object.fromEntries(seatedPlayers.map((player) => [
      player.id,
      createAgentMemory({ gameId, player, players: seatedPlayers })
    ])),
    aiTraces: [],
    seerKnowledge: {},
    witch: { saveAvailable: true, poisonAvailable: true },
    wolfRoom: { messages: [], proposals: [], plan: null },
    night: {},
    discussionIndex: 0,
    duelIndex: 0,
    lastWordsPlayerId: null,
    votes: {},
    voteIndex: 0,
    tieCandidates: [],
    winner: null,
    nextEventId: 1,
    nextPrivateEventId: 1,
    nextTraceId: 1,
    nextErrorId: 1,
    errorLog: [],
    onlineAI,
    debugMode: developerMode,
    revealedRoles: [],
    ended: false,
    error: null,
    errorDetail: null,
    invariantErrors: [],
    phaseHistory: [{ day: 1, phase: "night_wolf" }],
    maxDays: 30,
    actionCount: 0,
    liveAIProcess: null,
    lastAIProcess: null,
    metrics: { modelCalls: 0, modelSuccesses: 0, modelRetries: 0, modelFailures: 0, streamCalls: 0, streamFallbacks: 0, lastError: "" }
  };
}

function startGame(playerName, roleMode, onlineAI, developerMode = appPreferences.developerMode, seedOverride = null) {
  if (!hasOnlineAIConfig()) {
    updateModelStatus("请先配置线上 AI");
    settingsDialog.showModal();
    return false;
  }
  const nextGame = createGame(playerName, roleMode, true, developerMode, seedOverride);
  activeGameRun = gameRuns.begin(nextGame.id);
  game = nextGame;
  advancing = false;
  lastInvariantSignature = "";
  pendingHuman = null;
  selectedTarget = null;
  speakingPlayerId = null;
  lobbyScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  addEvent("night", "系统", "身份已经分配。第一夜开始，所有人闭眼。");
  updateModelStatus();
  render();
  advanceGame(activeGameRun);
  return true;
}

function hasOnlineAIConfig() {
  return Boolean(modelSettings.baseUrl && modelSettings.model && modelSettings.apiKey);
}

function updateModelStatus(message) {
  if (message) modelStatus = message;
  const configured = hasOnlineAIConfig();
  el("connection-text").textContent = modelStatus;
  if (!game) {
    el("footer-ai").textContent = configured ? "线上 AI 已配置" : "需要配置线上 AI";
    return;
  }
  if (!configured) {
    el("footer-ai").textContent = "本局：线上 AI 未配置";
    return;
  }
  const { modelCalls = 0, modelSuccesses = 0, modelFailures = 0 } = game.metrics || {};
  el("footer-ai").textContent = `${modelSettings.dialect === "anthropic" ? "Anthropic" : "OpenAI"} 线上 AI · 调用 ${modelCalls} · 成功 ${modelSuccesses} · 失败 ${modelFailures}`;
}

function checkWinner() {
  const alive = alivePlayers();
  const wolves = alive.filter((player) => player.role === "werewolf");
  const villagers = alive.filter((player) => player.role === "villager");
  const gods = alive.filter((player) => player.role === "seer" || player.role === "witch");
  if (wolves.length === 0) return "village";
  if (villagers.length === 0 || gods.length === 0) return "werewolf";
  return null;
}

function finishIfNeeded() {
  const winner = checkWinner();
  if (!winner) return false;
  game.winner = winner;
  game.ended = true;
  game.phase = "ended";
  game.phaseHistory.push({ day: game.day, phase: "ended" });
  const copy = winner === "village" ? "所有狼人已经出局，好人阵营获胜。" : "狼人完成屠边，狼人阵营获胜。";
  addEvent("death", "系统", copy);
  pendingHuman = null;
  render();
  return true;
}

function delay(ms = 260, run = activeGameRun) {
  const wait = simulationMode || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));
  return wait.then(() => {
    if (run) gameRuns.assertCurrent(run);
  });
}

async function advanceGame(run = activeGameRun) {
  const runGame = game;
  if (!runGame || !gameRuns.isCurrent(run) || advancing || pendingHuman || runGame.phase === "ended") return;
  advancing = true;
  try {
    while (gameRuns.isCurrent(run) && game === runGame && !pendingHuman && runGame.phase !== "ended") {
      render();
      if (runGame.phase === "night_wolf") await handleWolfNight();
      else if (runGame.phase === "night_witch") await handleWitchNight();
      else if (runGame.phase === "night_seer") await handleSeerNight();
      else if (runGame.phase === "night_resolve") await resolveNight();
      else if (runGame.phase === "dawn") await handleDawn();
      else if (runGame.phase === "discussion") await handleDiscussion();
      else if (runGame.phase === "vote_duel") await handleDuelSpeech();
      else if (runGame.phase === "last_words") await handleLastWords();
      else if (runGame.phase === "vote" || runGame.phase === "vote_retry") await handleVote();
      else break;
    }
  } catch (error) {
    if (isStaleGameRunError(error) || !gameRuns.isCurrent(run) || game !== runGame) return;
    const message = `状态机异常：${String(error?.message || error).slice(0, 180)}`;
    recordErrorLog({ source: "state-machine", error });
    game.error = "本局发生错误，对局已暂停。";
    game.errorDetail = message;
    game.liveAIProcess = null;
    game.invariantErrors = [...new Set([...(game.invariantErrors || []), message])];
    console.error("Game state machine error:", error);
  } finally {
    if (gameRuns.isCurrent(run) && game === runGame) {
      advancing = false;
      render();
    }
  }
}

async function handleWolfNight() {
  const wolves = alivePlayers().filter((player) => player.role === "werewolf");
  game.night.wolfNominations ||= {};
  const nextWolf = wolves.find((wolf) => !(wolf.id in game.night.wolfNominations));
  if (!nextWolf) {
    const nominations = Object.values(game.night.wolfNominations);
    const captain = wolves[(game.day - 1) % wolves.length];
    const targetId = nominations.every((target) => target === nominations[0])
      ? nominations[0]
      : game.night.wolfNominations[captain.id] || nominations[0];
    game.night.wolfTarget = targetId;
    finalizeWolfPlan(wolves, captain, targetId);
    setPhase("night_witch");
    return;
  }
  const candidates = alivePlayers().map((player) => player.id);
  if (nextWolf.controller === "human") {
    pendingHuman = { kind: "wolf", playerId: nextWolf.id, candidates };
    return;
  }
  speakingPlayerId = nextWolf.id;
  render();
  const decision = await getAIDecision(nextWolf, "wolf", candidates);
  game.night.wolfNominations[nextWolf.id] = decision.targetId;
  recordWolfProposal(nextWolf, decision.targetId, decision.reasoningSummary);
  speakingPlayerId = null;
  await delay();
}

function recordWolfProposal(player, targetId, reason = "提交了刀口提案。") {
  const proposal = {
    proposerId: player.id,
    targetId,
    reason: reasoningSummary(reason, "提交了刀口提案。"),
    day: game.day
  };
  game.wolfRoom.proposals.push(proposal);
  game.wolfRoom.messages.push({
    speakerId: player.id,
    day: game.day,
    text: `提议刀 ${seatLabel(targetId)}：${proposal.reason}`
  });
  addWolfMemoryEvent(`提议刀 ${seatLabel(targetId)}：${proposal.reason}`, player.id);
}

function finalizeWolfPlan(wolves, captain, targetId) {
  const taskByWolf = Object.fromEntries(wolves.map((wolf) => [wolf.id, "HIDE"]));
  if (wolves.length) taskByWolf[captain.id] = "PUSH_VOTE";
  const selfTarget = playerById(targetId)?.role === "werewolf" ? targetId : null;
  if (selfTarget) taskByWolf[selfTarget] = "BAIT_WITCH";
  const taskNames = { HIDE: "隐藏身份", PUSH_VOTE: "白天推动票型", BAIT_WITCH: "自刀骗药" };
  const taskSummary = wolves.map((wolf) => `${seatLabel(wolf.id)}:${taskNames[taskByWolf[wolf.id]]}`).join("、");
  game.wolfRoom.plan = {
    killTargetId: targetId,
    taskByWolf,
    sacrificeCandidateId: selfTarget,
    summary: `队长确认刀口为${seatLabel(targetId)}；本轮分工：${taskSummary}。`
  };
  game.wolfRoom.messages.push({ speakerId: captain.id, day: game.day, text: game.wolfRoom.plan.summary });
  addWolfMemoryEvent(game.wolfRoom.plan.summary, captain.id);
}

async function handleWitchNight() {
  const witch = alivePlayers().find((player) => player.role === "witch");
  if (!witch || game.night.witchAction) {
    setPhase("night_seer");
    return;
  }
  const candidates = alivePlayers().filter((player) => player.id !== witch.id).map((player) => player.id);
  if (witch.controller === "human") {
    pendingHuman = { kind: "witch", playerId: witch.id, candidates, killTargetId: game.night.wolfTarget };
    return;
  }
  speakingPlayerId = witch.id;
  render();
  game.night.witchAction = await getAIDecision(witch, "witch", candidates, { killTargetId: game.night.wolfTarget });
  recordWitchNightMemory(witch.id);
  speakingPlayerId = null;
  await delay();
  setPhase("night_seer");
}

async function handleSeerNight() {
  const seer = alivePlayers().find((player) => player.role === "seer");
  if (!seer || game.night.seerTarget) {
    setPhase("night_resolve");
    return;
  }
  const checked = new Set(Object.keys(game.seerKnowledge[seer.id] || {}));
  let candidates = alivePlayers().filter((player) => player.id !== seer.id && !checked.has(player.id)).map((player) => player.id);
  if (!candidates.length) candidates = alivePlayers().filter((player) => player.id !== seer.id).map((player) => player.id);
  if (seer.controller === "human") {
    pendingHuman = { kind: "seer", playerId: seer.id, candidates };
    return;
  }
  speakingPlayerId = seer.id;
  render();
  const decision = await getAIDecision(seer, "seer", candidates);
  applySeerCheck(seer.id, decision.targetId);
  speakingPlayerId = null;
  await delay();
  setPhase("night_resolve");
}

function applySeerCheck(seerId, targetId) {
  const target = playerById(targetId);
  game.night.seerTarget = targetId;
  game.seerKnowledge[seerId] ||= {};
  game.seerKnowledge[seerId][targetId] = ROLES[target.role].faction;
  addPrivateMemoryEvent(seerId, `${seatLabel(target.id)} 属于${ROLES[target.role].faction === "werewolf" ? "狼人" : "好人"}阵营。`, "seer-check");
}

async function resolveNight() {
  const deaths = new Set();
  const witchAction = game.night.witchAction || { action: "pass" };
  if (game.night.wolfTarget && witchAction.action !== "save") deaths.add(game.night.wolfTarget);
  if (witchAction.action === "poison" && witchAction.targetId) deaths.add(witchAction.targetId);
  for (const id of deaths) {
    const player = playerById(id);
    if (player) player.alive = false;
  }
  if (witchAction.action === "save") game.witch.saveAvailable = false;
  if (witchAction.action === "poison") game.witch.poisonAvailable = false;
  game.night.deaths = [...deaths];
  setPhase("dawn");
  await delay(340);
}

async function handleDawn() {
  const deaths = (game.night.deaths || []).map(playerById).filter(Boolean);
  if (deaths.length) addEvent("death", "系统", `昨夜 ${deaths.map((player) => seatLabel(player.id)).join("、")} 出局。`);
  else addEvent("night", "系统", "昨夜平安无事。所有人睁眼。");
  if (finishIfNeeded()) return;
  game.discussionIndex = 0;
  setPhase("discussion");
  await delay(320);
}

async function handleDiscussion() {
  const order = alivePlayers().sort((a, b) => a.seat - b.seat);
  if (game.discussionIndex >= order.length) {
    game.votes = {};
    game.voteIndex = 0;
    setPhase("vote");
    return;
  }
  const player = order[game.discussionIndex];
  if (player.controller === "human") {
    pendingHuman = { kind: "speech", playerId: player.id, canExplode: player.role === "werewolf" };
    return;
  }
  speakingPlayerId = player.id;
  render();
  const decision = await getAIDecision(player, "speech", []);
  if (decision.action === "explode" && player.role === "werewolf") {
    speakingPlayerId = null;
    explodeWolf(player.id);
    return;
  }
  const speechEvent = addEvent("speech", seatLabel(player.id), decision.speech);
  registerSpeechClaims(player.id, decision.speech, speechEvent.id, decision.speechActs);
  recordSpeechMetadata(player, decision.speech, decision, speechEvent.id);
  speakingPlayerId = null;
  game.discussionIndex += 1;
  await delay(380);
}

async function handleDuelSpeech() {
  const candidates = game.tieCandidates.map(playerById).filter((player) => player?.alive);
  if (game.duelIndex >= candidates.length) {
    game.votes = {};
    game.voteIndex = 0;
    setPhase("vote_retry");
    return;
  }
  const player = candidates[game.duelIndex];
  if (player.controller === "human") {
    pendingHuman = { kind: "duel_speech", playerId: player.id };
    return;
  }
  speakingPlayerId = player.id;
  render();
  const decision = await getAIDecision(player, "speech", [], { canExplode: false, duel: true });
  const speechEvent = addEvent("speech", seatLabel(player.id), decision.speech);
  registerSpeechClaims(player.id, decision.speech, speechEvent.id, decision.speechActs);
  recordSpeechMetadata(player, decision.speech, decision, speechEvent.id);
  speakingPlayerId = null;
  game.duelIndex += 1;
  await delay(380);
}

function completeLastWords() {
  game.lastWordsPlayerId = null;
  if (!finishIfNeeded()) beginNextNight();
}

async function handleLastWords() {
  const player = playerById(game.lastWordsPlayerId);
  if (!player) {
    completeLastWords();
    return;
  }
  if (player.controller === "human") {
    pendingHuman = { kind: "last_words", playerId: player.id };
    return;
  }
  speakingPlayerId = player.id;
  render();
  const decision = await getAIDecision(player, "speech", [], { canExplode: false, lastWords: true });
  const speechEvent = addEvent("speech", seatLabel(player.id), decision.speech);
  registerSpeechClaims(player.id, decision.speech, speechEvent.id, decision.speechActs);
  recordSpeechMetadata(player, decision.speech, decision, speechEvent.id);
  speakingPlayerId = null;
  completeLastWords();
  await delay(380);
}

async function handleVote() {
  const voters = alivePlayers().sort((a, b) => a.seat - b.seat);
  if (game.voteIndex >= voters.length) {
    resolveVote();
    return;
  }
  const voter = voters[game.voteIndex];
  const pool = game.phase === "vote_retry" ? game.tieCandidates : voters.map((player) => player.id);
  const candidates = [ABSTAIN, ...pool.filter((id) => id !== voter.id && playerById(id)?.alive)];
  if (!candidates.length) {
    game.voteIndex += 1;
    return;
  }
  if (voter.controller === "human") {
    pendingHuman = { kind: "vote", playerId: voter.id, candidates };
    return;
  }
  speakingPlayerId = voter.id;
  render();
  const decision = await getAIDecision(voter, "vote", candidates);
  game.votes[voter.id] = decision.targetId;
  speakingPlayerId = null;
  game.voteIndex += 1;
  await delay(220);
}

function resolveVote() {
  const counts = {};
  for (const targetId of Object.values(game.votes)) {
    if (targetId !== ABSTAIN) counts[targetId] = (counts[targetId] || 0) + 1;
  }
  const highest = Math.max(0, ...Object.values(counts));
  const tied = Object.keys(counts).filter((id) => counts[id] === highest);
  const voteCopy = Object.entries(game.votes).map(([voterId, targetId]) => `${playerById(voterId).seat + 1}→${targetId === ABSTAIN ? "弃" : playerById(targetId).seat + 1}`).join("、");
  if (voteCopy) {
    const voteEvent = addEvent("vote", "系统", `票型：${voteCopy}`);
    recordVoteEvidence(game.votes, voteEvent.id);
  }
  if (highest === 0) {
    addEvent("vote", "系统", "没有有效票，本轮无人出局。");
    if (!finishIfNeeded()) beginNextNight();
    return;
  }
  if (tied.length > 1 && game.phase === "vote") {
    game.tieCandidates = tied;
    game.votes = {};
    game.voteIndex = 0;
    game.duelIndex = 0;
    addEvent("vote", "系统", `${tied.map((id) => `${playerById(id).seat + 1} 号`).join("、")} 平票，进入决战台。`);
    addEvent("vote", "系统", "并列玩家进入决战台，按座位号依次进行最后陈述。");
    setPhase("vote_duel");
    return;
  }
  if (tied.length !== 1) {
    addEvent("vote", "系统", "再次平票，本轮无人出局。");
    if (!finishIfNeeded()) beginNextNight();
    return;
  }
  const eliminated = playerById(tied[0]);
  eliminated.alive = false;
  addEvent("death", "系统", `${seatLabel(eliminated.id)} 被放逐出局。`);
  game.lastWordsPlayerId = eliminated.id;
  setPhase("last_words");
}

function explodeWolf(playerId) {
  const player = playerById(playerId);
  if (!player || game.phase !== "discussion" || player.role !== "werewolf" || !player.alive) return false;
  player.alive = false;
  game.revealedRoles.push(player.id);
  addEvent("death", "系统", `${seatLabel(player.id)} 自爆，公开确认是狼人，跳过本轮投票。`);
  if (!finishIfNeeded()) beginNextNight();
  return true;
}

function beginNextNight() {
  recordRoundSummaries(game.day);
  game.day += 1;
  for (const memory of Object.values(game.agentMemories)) expireSecondOrderBeliefs(memory, game.day);
  game.night = {};
  game.votes = {};
  game.voteIndex = 0;
  game.duelIndex = 0;
  game.tieCandidates = [];
  game.lastWordsPlayerId = null;
  game.wolfRoom.plan = null;
  addEvent("night", "系统", `第 ${game.day} 夜开始，所有人闭眼。`);
  setPhase("night_wolf");
}

function legalTarget(targetId, candidates) {
  if (targetId === ABSTAIN) return candidates.includes(ABSTAIN);
  return candidates.includes(targetId) && Boolean(playerById(targetId)?.alive);
}

function normalizeHumanSpeech(value) {
  const result = validatePublicSpeech(value, game.players);
  if (!result.ok) updateModelStatus(result.reason);
  return result.ok ? result.text : null;
}

function submitHuman(action) {
  if (!pendingHuman || !game) return;
  game.actionCount += 1;
  const pending = pendingHuman;
  if (["wolf", "seer", "vote"].includes(pending.kind) && !legalTarget(action.targetId, pending.candidates)) return;
  if (pending.kind === "wolf") {
    game.night.wolfNominations[pending.playerId] = action.targetId;
    const player = playerById(pending.playerId);
    recordWolfProposal(player, action.targetId, "人类狼人提交了刀口提案。");
  }
  else if (pending.kind === "seer") applySeerCheck(pending.playerId, action.targetId);
  else if (pending.kind === "witch") {
    const resourceCheck = validateWitchActionResources(action.action, {
      saveAvailable: game.witch.saveAvailable,
      poisonAvailable: game.witch.poisonAvailable,
      killTargetId: pending.killTargetId
    });
    if (!resourceCheck.ok) {
      updateModelStatus(resourceCheck.reason);
      return;
    }
    if (action.action === "poison" && !legalTarget(action.targetId, pending.candidates)) return;
    game.night.witchAction = action;
    recordWitchNightMemory(pending.playerId);
  } else if (pending.kind === "speech" && action.action === "explode") {
    if (!pending.canExplode) return;
    explodeWolf(pending.playerId);
  } else if (pending.kind === "speech") {
    const speech = normalizeHumanSpeech(action.speech);
    if (!speech) return;
    const speaker = playerById(pending.playerId);
    const speechEvent = addEvent("speech", seatLabel(pending.playerId), speech);
    registerSpeechClaims(pending.playerId, speech, speechEvent.id);
    recordSpeechMetadata(speaker, speech, {}, speechEvent.id);
    game.discussionIndex += 1;
  } else if (pending.kind === "duel_speech") {
    const speech = normalizeHumanSpeech(action.speech);
    if (!speech) return;
    const speaker = playerById(pending.playerId);
    const speechEvent = addEvent("speech", seatLabel(pending.playerId), speech);
    registerSpeechClaims(pending.playerId, speech, speechEvent.id);
    recordSpeechMetadata(speaker, speech, {}, speechEvent.id);
    game.duelIndex += 1;
  } else if (pending.kind === "last_words") {
    const speech = normalizeHumanSpeech(action.speech);
    if (!speech) return;
    const speaker = playerById(pending.playerId);
    const speechEvent = addEvent("speech", seatLabel(pending.playerId), speech);
    registerSpeechClaims(pending.playerId, speech, speechEvent.id);
    recordSpeechMetadata(speaker, speech, {}, speechEvent.id);
    completeLastWords();
  } else if (pending.kind === "vote") {
    game.votes[pending.playerId] = action.targetId;
    game.voteIndex += 1;
  }
  pendingHuman = null;
  selectedTarget = null;
  render();
  advanceGame();
}

function publicHistory() {
  return game.events.slice(-16).map((event) => `${event.actor}: ${event.text}`).join("\n");
}

function privateContext(player) {
  const memory = game.agentMemories[player.id];
  const teammates = game.players
    .filter((item) => item.role === "werewolf" && item.id !== player.id)
    .map((item) => seatLabel(item.id));
  const context = buildAgentContext({
    gameId: game.id,
    day: game.day,
    phase: visiblePhaseForPlayer(game.phase, player.role),
    self: {
      id: player.id,
      seat: player.seat + 1,
      role: player.role,
      faction: ROLES[player.role].faction
    },
    memory,
    aliveSeats: alivePlayers().map((item) => item.seat + 1),
    publicRounds: game.events.slice(-16),
    currentRoundEvents: game.events.filter((event) => event.day === game.day).slice(-12),
    voteHistory: game.events.filter((event) => event.kind === "vote").slice(-8),
    teammates,
    wolfRoom: {
      messages: game.wolfRoom.messages.slice(-8).map((message) => ({
        speaker: seatLabel(message.speakerId),
        text: message.text
      })),
      proposals: game.wolfRoom.proposals.slice(-8),
      plan: game.wolfRoom.plan
    },
    seerResults: Object.entries(game.seerKnowledge[player.id] || {}).map(([id, faction]) => ({
      seat: seatLabel(id),
      faction
    })),
    witchState: {
      saveAvailable: game.witch.saveAvailable,
      poisonAvailable: game.witch.poisonAvailable,
      killTarget: game.night.wolfTarget ? seatLabel(game.night.wolfTarget) : null
    },
    legalActions: [],
    persona: player.persona,
    promptVersion: "v1-context-boundary"
  });
  const lines = [`你的座位是${seatLabel(player.id)}。你的身份是${ROLES[player.role].name}，阵营是${ROLES[player.role].faction === "werewolf" ? "狼人" : "好人"}。`];
  const aliveSeatSet = new Set(context.game.aliveSeats);
  const deadSeats = game.players.map((item) => item.seat + 1).filter((seat) => !aliveSeatSet.has(seat));
  lines.push(`当前存活座位：${context.game.aliveSeats.map((seat) => `${seat}号`).join("、") || "无"}。已出局座位：${deadSeats.map((seat) => `${seat}号`).join("、") || "无"}；不得要求已出局玩家继续回应、解释或参与投票。`);
  lines.push(memoryPrompt(memory, seatLabel));
  const privateEvents = context.self.privateEvents.slice(-6).map((event) => event.text);
  if (privateEvents.length) lines.push(`你最近的私密事实：${privateEvents.join("；")}`);
  const voteHistory = context.game.voteHistory.map((event) => event.text).filter(Boolean);
  if (voteHistory.length) lines.push(`历史完整票型：${voteHistory.join("；")}`);
  if (context.wolfRoom) {
    lines.push(`你的狼人队友：${context.wolfRoom.teammates.join("、")}。`);
    if (context.wolfRoom.messages.length) lines.push(`狼队私聊：${context.wolfRoom.messages.map((message) => `${message.speaker}：${message.text}`).join("\n")}`);
    if (context.wolfRoom.plan) lines.push(`狼队计划：${context.wolfRoom.plan.summary}`);
  }
  if (context.roleFacts?.seerResults) {
    const results = context.roleFacts.seerResults.map((result) => `${result.seat}是${result.faction === "werewolf" ? "狼人" : "好人"}`);
    lines.push(`你的查验记录：${results.join("；") || "暂无"}。`);
  }
  if (context.roleFacts?.witchState) {
    const state = context.roleFacts.witchState;
    lines.push(`解药${state.saveAvailable ? "可用" : "已用"}，毒药${state.poisonAvailable ? "可用" : "已用"}。`);
    if (state.killTarget) lines.push(`本夜狼刀目标：${state.killTarget}。`);
  }
  return lines.join("\n");
}

function seerClaim(player) {
  if (player.role !== "seer") return null;
  const checks = Object.entries(game.seerKnowledge[player.id] || {}).map(([targetId, faction]) => ({ targetId, faction }));
  return { playerId: player.id, role: "seer", checks, day: game.day };
}

function speechActContext(player) {
  const witchAction = game.night.witchAction || null;
  const witchTargetId = witchAction?.action === "poison" ? witchAction.targetId : game.night.wolfTarget;
  return {
    speakerRole: player.role,
    speakerSeat: player.seat + 1,
    seerChecks: Object.entries(game.seerKnowledge[player.id] || {}).map(([targetId, result]) => ({
      targetSeat: playerById(targetId)?.seat + 1,
      result
    })),
    witchAction: witchAction?.action || null,
    witchTargetSeat: playerById(witchTargetId)?.seat + 1 || null
  };
}

function prepareSpeechActs(player, decision) {
  let acts = normalizeSpeechActs(decision.speechActs);
  const bluffPlan = player.role === "werewolf" ? wolfBluffPlan(player) : null;
  if (bluffPlan) {
    const target = playerById(bluffPlan.targetId);
    acts = acts.filter((act) => ![
      SPEECH_ACT_TYPES.ROLE_CLAIM,
      SPEECH_ACT_TYPES.SEER_RESULT
    ].includes(act.type));
    acts.push({ type: SPEECH_ACT_TYPES.ROLE_CLAIM, role: "seer" });
    if (target) acts.push({
      type: SPEECH_ACT_TYPES.SEER_RESULT,
      targetSeat: target.seat + 1,
      result: bluffPlan.faction
    });
  }
  const validation = validateSpeechActs(acts, speechActContext(player));
  return {
    acts: validation.ok ? validation.acceptedActs : [],
    warnings: validation.errors,
    rejectedActs: validation.rejectedActs,
    bluffPlan
  };
}

function registerSpeechClaims(speakerId, speech, sourceEventId, speechActs = null) {
  const speaker = playerById(speakerId);
  if (!speaker || !speech) return;
  const nodes = [];
  const hasStructuredActs = Array.isArray(speechActs);
  const normalizedActs = hasStructuredActs ? normalizeSpeechActs(speechActs) : [];
  const factualActs = hasStructuredActs ? claimsFromSpeechActs(normalizedActs) : [];
  const claimsSeer = hasStructuredActs
    ? factualActs.some((act) => act.type === SPEECH_ACT_TYPES.ROLE_CLAIM && act.role === "seer")
    : isSeerClaimText(speech);
  const parsedSeerClaim = hasStructuredActs ? null : extractPublicSeerClaim(speech, {
      speakerId,
      speakerSeat: speaker.seat + 1,
      day: game.day
    });
  const parsedChecks = hasStructuredActs
    ? factualActs.filter((act) => act.type === SPEECH_ACT_TYPES.SEER_RESULT).map((act) => {
      const target = game.players.find((player) => player.seat + 1 === act.targetSeat);
      return target ? { targetId: target.id, targetSeat: target.seat + 1, faction: act.result } : null;
    }).filter(Boolean)
    : (parsedSeerClaim?.checks || []).map((check) => {
      const target = game.players.find((player) => player.seat + 1 === check.targetSeat);
      return target ? { targetId: target.id, targetSeat: target.seat + 1, faction: check.faction } : null;
    }).filter(Boolean);
  if (claimsSeer || parsedSeerClaim) {
    const previousClaim = game.publicClaims.find((item) => item.playerId === speakerId && item.role === "seer");
    const checksByTarget = new Map((previousClaim?.checks || []).map((check) => [check.targetId, check.faction]));
    parsedChecks.forEach((check) => checksByTarget.set(check.targetId, check.faction));
    game.publicClaims = game.publicClaims.filter((item) => item.playerId !== speakerId);
    game.publicClaims.push({
      playerId: speakerId,
      role: "seer",
      checks: [...checksByTarget].map(([targetId, faction]) => ({ targetId, faction })),
      day: game.day
    });
  }
  if (claimsSeer) {
    nodes.push(addClaimNode(game.claimGraph, {
      day: game.day,
      speakerId,
      speakerSeat: speaker.seat + 1,
      type: CLAIM_TYPES.ROLE_CLAIM,
      targetId: speakerId,
      targetSeat: speaker.seat + 1,
      claimedValue: "seer",
      sourceEventId
    }));
    for (const check of parsedChecks) {
      nodes.push(addClaimNode(game.claimGraph, {
        day: game.day,
        speakerId,
        speakerSeat: speaker.seat + 1,
        type: CLAIM_TYPES.SEER_RESULT_CLAIM,
        targetId: check.targetId,
        targetSeat: check.targetSeat,
        claimedValue: check.faction,
        sourceEventId
      }));
    }
  }
  if (hasStructuredActs) {
    for (const act of normalizedActs.filter((item) => item.type === SPEECH_ACT_TYPES.SUSPICION)) {
      const target = game.players.find((player) => player.seat + 1 === act.targetSeat);
      if (!target) continue;
      nodes.push(addClaimNode(game.claimGraph, {
        day: game.day,
        speakerId,
        speakerSeat: speaker.seat + 1,
        type: CLAIM_TYPES.IDENTITY_HYPOTHESIS,
        targetId: target.id,
        targetSeat: target.seat + 1,
        claimedValue: act.result,
        sourceEventId
      }));
    }
  } else {
    const parsedCheckKeys = new Set(parsedChecks.map((check) => `${check.targetId}:${check.faction}`));
    const resultPattern = /([1-6])\s*号(?:是|为)?\s*(查杀|狼人|金水|好人)/g;
    for (const match of speech.matchAll(resultPattern)) {
      const target = game.players.find((player) => player.seat + 1 === Number(match[1]));
      if (!target) continue;
      const claimedValue = ["查杀", "狼人"].includes(match[2]) ? "werewolf" : "village";
      if (claimsSeer && parsedCheckKeys.has(`${target.id}:${claimedValue}`)) continue;
      nodes.push(addClaimNode(game.claimGraph, {
        day: game.day,
        speakerId,
        speakerSeat: speaker.seat + 1,
        type: claimsSeer ? CLAIM_TYPES.SEER_RESULT_CLAIM : CLAIM_TYPES.IDENTITY_HYPOTHESIS,
        targetId: target.id,
        targetSeat: target.seat + 1,
        claimedValue,
        sourceEventId
      }));
    }
  }
  for (const memory of Object.values(game.agentMemories)) {
    if (!memory || !playerById(memory.playerId)?.alive) continue;
    for (const node of nodes.filter(Boolean)) addClaimToMemory(memory, node);
  }
}

function isSeerClaimText(text) {
  return isExplicitSeerClaim(text);
}

function wolfHasPublicSeerClaim() {
  return game.publicClaims.some((claim) => claim.role === "seer" && playerById(claim.playerId)?.role === "werewolf");
}

function wolfBluffPlan(player) {
  if (!player || player.role !== "werewolf" || game.phase !== "discussion") return null;
  if (wolfHasPublicSeerClaim()) return null;
  const wolves = alivePlayers().filter((item) => item.role === "werewolf").sort((left, right) => left.seat - right.seat);
  const spokenWolfIds = new Set(game.events
    .filter((event) => event.kind === "speech" && event.day === game.day)
    .map((event) => game.players.find((item) => event.actor === seatLabel(item.id)))
    .filter((item) => item?.role === "werewolf")
    .map((item) => item.id));
  const firstUnspokenWolf = wolves.find((item) => !spokenWolfIds.has(item.id));
  if (!firstUnspokenWolf || firstUnspokenWolf.id !== player.id) return null;
  if (game.day !== 1 && publicSeerClaims().length === 0) return null;

  const publicWolfTarget = claimedWolfTargets(alivePlayers().map((item) => item.id))[0];
  if (publicWolfTarget) {
    return {
      targetId: publicWolfTarget,
      faction: "village",
      result: "好人",
      reason: `反跳对冲公开查杀${seatLabel(publicWolfTarget)}，争取让好人重新比较两边预言家`
    };
  }
  const teammateIds = new Set(wolves.filter((item) => item.id !== player.id).map((item) => item.id));
  const target = alivePlayers().find((item) => item.id !== player.id && !teammateIds.has(item.id));
  if (!target) return null;
  return {
    targetId: target.id,
    faction: "werewolf",
    result: "狼人",
    reason: `主动悍跳并给${seatLabel(target.id)}查杀，制造第二条可比较的信息链`
  };
}

function recordVoteEvidence(votes, eventId) {
  for (const [voterId, targetId] of Object.entries(votes)) {
    if (targetId === ABSTAIN) continue;
    const voter = playerById(voterId);
    const target = playerById(targetId);
    if (!voter || !target) continue;
    for (const memory of Object.values(game.agentMemories)) {
      if (!memory || !playerById(memory.playerId)?.alive) continue;
      addBeliefEvidence(memory, target.id, {
        eventId,
        delta: 1,
        summary: `${voter.seat + 1}号公开投向${target.seat + 1}号。`,
        alternatives: ["可能是基于查验、站边、错误判断或阵营收益的选择。"]
      });
    }
  }
}

function recordRoundSummaries(day) {
  for (const memory of Object.values(game.agentMemories)) {
    if (!memory) continue;
    const events = memory.publicEvents.filter((event) => event.day === day).slice(-6);
    if (!events.length) continue;
    memory.roundSummaries.push({
      day,
      text: events.map((event) => event.text).join("；").slice(0, 320),
      evidenceEventIds: events.map((event) => event.id)
    });
    if (memory.roundSummaries.length > 8) memory.roundSummaries.shift();
  }
}

function refreshInvariantState() {
  if (!game) return;
  const errors = validateGameState(game);
  game.invariantErrors = errors;
  const signature = errors.join("|");
  if (signature && signature !== lastInvariantSignature) {
    console.error("Game invariant violation:", errors);
    errors.forEach((error) => recordErrorLog({ source: "invariant", error }));
  }
  lastInvariantSignature = signature;
}

function reasoningSummary(value, fallback) {
  const summary = String(value || "").trim().slice(0, 140);
  return summary || fallback;
}

function seatIdFromSpeechValue(value) {
  const match = String(value ?? "").match(/([1-6])/);
  if (!match) return null;
  const seat = Number(match[1]);
  return game.players.find((player) => player.seat + 1 === seat)?.id || null;
}

function defaultCommunicationIntent(player, speech, action) {
  if (action === "explode") return "concede";
  if (player.role === "seer" || isSeerClaimText(speech)) return "declare";
  if (/(怀疑|投|放逐|归票|优先处理)/.test(speech)) return "persuade";
  if (/(为什么|解释|验证|如果.*才)/.test(speech)) return "probe";
  if (/(质疑|反驳|不是我|别把)/.test(speech)) return "defend";
  return "inform";
}

function decisionClaimsRole(decision, role, speech = decision?.speech) {
  if (Array.isArray(decision?.speechActs)) {
    return normalizeSpeechActs(decision.speechActs)
      .some((act) => act.type === SPEECH_ACT_TYPES.ROLE_CLAIM && act.role === role);
  }
  return role === "seer" ? isSeerClaimText(speech) : role === "witch" ? isExplicitWitchClaim(speech) : false;
}

function normalizeSpeechMetadata(player, decision, extra = {}) {
  const speech = String(decision.speech || "").trim();
  const action = decision.action;
  const communicationIntent = COMMUNICATION_INTENTS.includes(decision.communicationIntent)
    ? decision.communicationIntent
    : defaultCommunicationIntent(player, speech, action);
  const pressureLevel = PRESSURE_LEVELS.includes(decision.pressureLevel)
    ? decision.pressureLevel
    : action === "explode"
      ? "sacrifice"
      : extra.canExplode === false || game.phase === "vote_duel" || game.phase === "last_words"
        ? "high"
        : game.publicClaims.length > 1
          ? "medium"
          : "low";
  const claimsSeer = decisionClaimsRole(decision, "seer", speech);
  const disclosurePlan = planDisclosure({
    role: player.role,
    pressureLevel,
    hasUnreportedSeerResults: player.role === "seer" && Boolean(seerClaim(player)?.checks?.length),
    claimsSeer
  });
  const fallbackDisclosureMode = player.role === "seer" && !claimsSeer
    ? "withhold"
    : disclosurePlan.mode;
  const disclosureMode = isDisclosureModeAllowed(player.role, decision.disclosureMode)
    ? decision.disclosureMode
    : fallbackDisclosureMode;
  const targetIds = (Array.isArray(decision.targetSeats) ? decision.targetSeats : [])
    .map(seatIdFromSpeechValue)
    .filter((id, index, list) => id && list.indexOf(id) === index)
    .slice(0, 3);
  return {
    communicationIntent,
    disclosureMode,
    pressureLevel,
    targetIds,
    expectedReaction: String(decision.expectedReaction || "希望其他玩家明确回应立场并留下可核对的票型。").slice(0, 120)
  };
}

function recordSpeechMetadata(player, speech, decision, sourceEventId) {
  const meta = normalizeSpeechMetadata(player, { ...decision, speech }, decision);
  const memory = game.agentMemories[player.id];
  memory.disclosurePlan = planDisclosure({
    role: player.role,
    pressureLevel: meta.pressureLevel,
    hasUnreportedSeerResults: player.role === "seer" && Boolean(seerClaim(player)?.checks?.length),
    claimsSeer: decisionClaimsRole(decision, "seer", speech),
    forced: meta.disclosureMode
  });
  recordCommunication(memory, {
    sourceEventId,
    day: game.day,
    intent: meta.communicationIntent,
    disclosureMode: meta.disclosureMode,
    pressureLevel: meta.pressureLevel,
    targetIds: meta.targetIds,
    expectedReaction: meta.expectedReaction,
    text: speech
  });
  if (player.role === "werewolf" && (meta.disclosureMode === "bluff" || decisionClaimsRole(decision, "seer", speech))) {
    recordDeception(memory, {
      type: "BLUFF",
      day: game.day,
      sourceEventId,
      claimedRole: "seer",
      claimedResults: [],
      publicTargetIds: meta.targetIds,
      fallback: "被真实预言家反证后转为质疑信息来源或切割。",
      exposureRisk: "后续查验、票型或身份翻牌与公开说法冲突。"
    });
  }
  if (player.role === "werewolf") {
    reconcileMemoryDeceptions(memory, {
      day: game.day,
      sourceEventId,
      claimedRole: isSeerClaimText(speech) ? "seer" : null,
      claimedResults: []
    });
  }
  return meta;
}

function promptFor(player, kind, candidates, extra = {}) {
  const legalTargetIds = candidates.join("、");
  const targetSeatMap = candidates.map((id) => id === ABSTAIN ? `${ABSTAIN}表示弃票` : `${id}对应${seatLabel(id)}`).join("、");
  const publicClaims = publicSeerClaims();
  const publicClaimText = publicClaims.length
    ? publicClaims.map((claim) => `${seatLabel(claim.playerId)}自称预言家：${(claim.checks || []).map((check) => `${seatLabel(check.targetId)}${check.faction === "werewolf" ? "查杀" : "好人结果"}`).join("、") || "暂无查验"}`).join("；")
    : "暂无公开预言家声明";
  const publicWolfTargets = claimedWolfTargets(alivePlayers().map((item) => item.id));
  const publicPriority = player.role !== "werewolf" && publicClaims.length === 1 && publicWolfTargets.length
    ? `当前只有一条公开预言家声明给出${publicWolfTargets.map(seatLabel).join("、")}查杀。首夜查验完全正常，声明即使来自已出局玩家也仍是公开证据，但不是身份翻牌；没有第二名预言家或硬性矛盾时，好人应优先核对查杀，强行保查杀或转攻预言家的人提高怀疑。`
    : "";
  const evidenceBoundary = "公开事实边界：系统的普通放逐和昨夜出局只确认座位与出局，不确认身份，也不确认狼刀、毒药或解药来源。玩家公开的身份、查验、刀口和用药内容都是该玩家的声明，不会自动升级为系统真值；无角色授权的信息只能使用“怀疑、可能、推测、待验证”等措辞。";
  const common = `当前是第${game.day}天，阶段：${visiblePhaseForPlayer(game.phase, player.role)}。你的座位：${seatLabel(player.id)}。\n${evidenceBoundary}\n公开预言家信息：${publicClaimText}\n局势优先级：${publicPriority || "结合公开发言、票型和死亡信息独立判断。"}\n公开记录：\n${publicHistory() || "暂无"}\n合法targetId（返回时只能原样填写其中一个ID，不要附加座位或说明）：${legalTargetIds || "无"}\n目标座位映射（仅供理解，不能作为targetId返回）：${targetSeatMap || "无"}`;
  const wolfBluff = kind === "speech" && player.role === "werewolf" ? wolfBluffPlan(player) : null;
  const wolfBluffInstruction = wolfBluff
    ? `狼队本轮已分配你悍跳预言家任务。必须公开说“我是预言家”，并报告${seatLabel(wolfBluff.targetId)}是${wolfBluff.result}；这是对外欺骗，不是私密真相。核心目的：${wolfBluff.reason}。`
    : "";
  const phaseInstruction = kind === "speech" && extra.lastWords
    ? `这是${seatLabel(player.id)}的放逐遗言：你已经被放逐，不能改变票型，也不能继续以存活玩家身份提问、安排下一轮或要求别人回应。必须明确说“我已经被放逐/我已经出局”，只复盘已经公开的发言和票型。`
    : kind === "speech" && extra.duel
      ? "这是决战台最后陈述：只针对当前并列者和公开票型补充理由，不要复述普通发言。"
      : "";
  return buildDecisionPrompt({
    common,
    role: player.role,
    kind,
    canExplode: player.role === "werewolf" && extra.canExplode !== false,
    witchTargetLabel: extra.killTargetId ? `${extra.killTargetId}=${seatLabel(extra.killTargetId)}` : "无",
    wolfBluffInstruction,
    phaseInstruction
  });
}

function parseJsonObject(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function readStreamingModelResponse(response) {
  if (!response.ok) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    throw new Error(payload.error || "模型流式请求失败");
  }
  if (!response.body?.getReader) throw new Error("浏览器不支持模型流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let done = false;
  const consume = (line) => {
    if (!line.startsWith("data:")) return;
    let event;
    try { event = JSON.parse(line.slice(5).trim()); } catch { throw new Error("本地代理返回了非法流式事件"); }
    if (event.type === "TEXT_DELTA") text += String(event.text || "");
    if (event.type === "ERROR") throw new Error(event.message || "模型流式请求失败");
    if (event.type === "TEXT_DONE") {
      if (typeof event.text === "string") text = event.text;
      done = true;
    }
  };
  while (!done) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    lines.forEach(consume);
  }
  if (buffer) consume(buffer);
  if (!text.trim()) throw new Error("模型未返回流式内容");
  return text;
}

async function callOnlineModel(player, kind, candidates, extra, operation) {
  const gameState = assertGameOperation(operation);
  const phaseSystem = extra.lastWords
    ? "你当前已经被放逐，只能发表一次遗言；遗言不是新一轮发言，不能追问存活玩家，也不能安排自己在下一轮的行动。"
    : "";
  const system = `你是六人狼人杀中的独立AI玩家。规则：2狼、2平民、预言家、女巫；屠边时狼人胜，狼人全灭时好人胜。只可使用提供给你的信息，不得假设其他玩家真实身份。普通放逐和夜间出局不翻牌，系统也不公布死因；玩家公开的身份、查验、刀口和用药内容都只是该玩家的声明，不会自动成为系统真值。你必须严格区分系统公开事实、角色授权的私人事实、其他玩家声明和待验证推断；没有角色授权时，死因只能使用“我怀疑、可能、大概率、推测、待验证”等措辞。${phaseSystem}\n${privateContext(player)}\n你的人格风格：${player.persona}。`;
  const requestId = `${gameState.id}:${gameState.day}:${player.id}:${kind}:${gameState.aiTraces.length + 1}`;
  const speechRetryGuidance = player.role === "witch"
    ? "如要公开刀口或用药，必须明确以“我是女巫”开头并只陈述自己的真实夜间记录；其他死因仍需标记为推测。"
    : player.role === "seer"
      ? "可以隐藏或部分公开；如报告查验，必须明确声明自己是预言家，并且只报告真实查验。"
      : "死因可以作为大胆假设，但必须使用“我怀疑/可能/大概率/推测/待验证”等标记，并说明要结合票型验证。";
  const run = async (attempt, previousError = "") => {
    const retryHint = previousError
      ? `\n上一次输出未通过校验（${previousError.slice(0, 120)}）。这次不要输出推理过程或 reasoning_content，只返回满足要求的最终 JSON，不要解释格式。${kind === "speech" ? speechRetryGuidance : ""}`
      : "";
    const streaming = kind === "speech" && modelSettings.streaming !== false;
    const configuredEffort = modelSettings.reasoningEffort;
    const baseMaxTokens = kind === "speech"
      ? ({ high: 2200, medium: 1700 }[configuredEffort] || 1400)
      : ({ high: 1400, medium: 1100 }[configuredEffort] || 900);
    const effort = attempt > 0 ? "" : modelSettings.reasoningEffort;
    const maxTokens = attempt > 0
      ? (kind === "speech" ? 2600 : 1800)
      : baseMaxTokens;
    assertGameOperation(operation);
    gameState.metrics.modelCalls += 1;
    if (streaming) gameState.metrics.streamCalls += 1;
    const requestBody = JSON.stringify({
      requestId,
      retryAttempt: attempt,
      dialect: modelSettings.dialect,
      baseUrl: modelSettings.baseUrl,
      endpointPath: modelSettings.endpointPath,
      apiKey: modelSettings.apiKey,
      model: modelSettings.model,
      temperature: modelSettings.temperature,
      maxTokens,
      reasoningEffort: effort,
      stream: streaming,
      system,
      messages: [{ role: "user", content: `${promptFor(player, kind, candidates, extra)}${retryHint}` }]
    });
    let useStream = streaming;
    let response = await fetch(useStream ? "/api/model-stream" : "/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      signal: operation.run.signal
    });
    assertGameOperation(operation);
    if (useStream && (response.status === 404 || response.status === 405)) {
      gameState.metrics.streamFallbacks += 1;
      useStream = false;
      response = await fetch("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        signal: operation.run.signal
      });
      assertGameOperation(operation);
    }
    const payload = useStream
      ? { text: await readStreamingModelResponse(response) }
      : await response.json();
    assertGameOperation(operation);
    if (!payload.text) throw new Error(payload.error || "模型未返回内容");
    const modelMeta = { reasoningTokens: Number(payload.reasoningTokens || 0) };
    const parsed = parseJsonObject(payload.text);
    if (!parsed) throw new Error("模型输出不是合法 JSON");
    const summary = reasoningSummary(parsed.reasoningSummary, "模型给出了动作，但没有返回可审计的简短依据。");
    if (kind === "speech" && parsed.action === "explode") {
      if (wolfBluffPlan(player)) throw new Error("狼队本轮已分配悍跳任务，不能用自爆跳过悍跳");
      if (player.role !== "werewolf" || extra.canExplode === false) throw new Error("当前阶段不能自爆");
      return { action: "explode", reasoningSummary: summary, modelMeta };
    }
    if (kind === "speech" && parsed.action !== "speak") throw new Error("公开发言 action 必须是 speak 或当前允许的 explode");
    if (kind === "speech" && parsed.disclosureMode && !isDisclosureModeAllowed(player.role, parsed.disclosureMode)) {
      throw new Error(`${ROLES[player.role].name}不能使用披露模式 ${parsed.disclosureMode}`);
    }
    if (kind === "speech" && typeof parsed.speech === "string" && parsed.speech.trim()) {
      let speech = parsed.speech.trim();
      const bluffPlan = player.role === "werewolf" ? wolfBluffPlan(player) : null;
      const bluffTarget = bluffPlan ? playerById(bluffPlan.targetId) : null;
      const bluffMatches = bluffPlan && bluffTarget
        ? matchesWolfBluffReport(speech, { targetSeat: bluffTarget.seat + 1, result: bluffPlan.result })
        : false;
      if (bluffPlan && bluffTarget && (!isSeerClaimText(speech) || !bluffMatches)) {
        const canonicalBluff = `我是预言家，昨晚查验${bluffTarget.seat + 1}号，${bluffTarget.seat + 1}号是${bluffPlan.result}。`;
        speech = `${canonicalBluff}${speech}`.slice(0, 180);
      }
      const speechCheck = validateAIPublicSpeechEnvelope(speech);
      if (!speechCheck.ok) {
        const error = new Error(speechCheck.reason);
        error.diagnostic = `模型发言：${speech.slice(0, 260)}`;
        throw error;
      }
      speech = speechCheck.text;
      return {
        speech,
        speechActs: parsed.speechActs,
        reasoningSummary: summary,
        communicationIntent: parsed.communicationIntent,
        disclosureMode: parsed.disclosureMode,
        targetSeats: parsed.targetSeats,
        pressureLevel: parsed.pressureLevel,
        expectedReaction: parsed.expectedReaction,
        modelMeta
      };
    }
    if (kind === "speech") throw new Error("模型公开发言为空");
    if (kind === "witch") {
      if (["pass", "save", "poison"].includes(parsed.action)) {
        const resourceCheck = validateWitchActionResources(parsed.action, {
          saveAvailable: game.witch.saveAvailable,
          poisonAvailable: game.witch.poisonAvailable,
          killTargetId: extra.killTargetId
        });
        if (!resourceCheck.ok) throw new Error(resourceCheck.reason);
        const targetId = normalizeModelTarget(parsed.targetId, candidates, game.players, ABSTAIN);
        if (parsed.action === "poison" && !legalTarget(targetId, candidates)) {
          const error = new Error("模型选择了非法毒药目标");
          error.diagnostic = targetDiagnostic(parsed.targetId, candidates, game.players, ABSTAIN);
          throw error;
        }
        return { action: parsed.action, targetId: parsed.action === "poison" ? targetId : null, reasoningSummary: summary, modelMeta };
      }
    }
    const priorityTarget = kind === "vote" ? priorityPublicWolfVote(player, candidates) : null;
    if (priorityTarget) {
      return {
        targetId: priorityTarget,
        reasoningSummary: "唯一存活公开预言家给出查杀，且没有第二名预言家或硬性矛盾；好人优先投出查杀目标。",
        modelMeta,
        modelOverride: parsed.targetId !== priorityTarget ? "公开查杀优先级覆盖模型原始票型" : null
      };
    }
    const targetId = normalizeModelTarget(parsed.targetId, candidates, game.players, ABSTAIN);
    if (legalTarget(targetId, candidates)) return { targetId, reasoningSummary: summary, modelMeta };
    const error = new Error("模型选择了非法目标");
    error.diagnostic = targetDiagnostic(parsed.targetId, candidates, game.players, ABSTAIN);
    throw error;
  };
  try {
    return await run(0);
  } catch (error) {
    if (isStaleGameRunError(error)) throw error;
    assertGameOperation(operation);
    gameState.metrics.lastError = error?.message || "模型请求失败";
    await delay(360);
    assertGameOperation(operation);
    gameState.metrics.modelRetries += 1;
    return run(1, error?.message || "格式校验失败");
  }
}

function publicSeerClaims() {
  return game.publicClaims.filter((claim) => claim.role === "seer" && playerById(claim.playerId));
}

function claimedWolfTargets(candidates) {
  return publicSeerClaims().flatMap((claim) => claim.checks)
    .filter((check) => check.faction === "werewolf" && candidates.includes(check.targetId) && playerById(check.targetId)?.alive)
    .map((check) => check.targetId);
}

function claimedGoodTargets(candidates) {
  return publicSeerClaims().flatMap((claim) => claim.checks)
    .filter((check) => check.faction !== "werewolf" && candidates.includes(check.targetId) && playerById(check.targetId)?.alive)
    .map((check) => check.targetId);
}

function priorityPublicWolfVote(player, candidates) {
  if (player.role === "werewolf" || publicSeerClaims().length !== 1) return null;
  return claimedWolfTargets(candidates)[0] || null;
}

function describeDecision(kind, decision) {
  if (kind === "speech" && decision.action === "explode") return "自爆并结束白天";
  if (kind === "speech") return `发言：${decision.speech}`;
  if (kind === "witch") {
    if (decision.action === "save") return "女巫使用解药";
    if (decision.action === "poison") return `女巫毒杀 ${seatLabel(decision.targetId)}`;
    return "女巫不使用药水";
  }
  const target = decision.targetId === ABSTAIN ? null : playerById(decision.targetId);
  if (kind === "vote" && decision.targetId === ABSTAIN) return "投票：弃票";
  const labels = { wolf: "狼刀", seer: "查验", vote: "投票" };
  return `${labels[kind] || kind}：${target ? seatLabel(target.id) : "无目标"}`;
}

function recordAITrace(player, kind, decision, source) {
  game.actionCount += 1;
  setReasoningSummary(game.agentMemories[player.id], reasoningSummary(decision.reasoningSummary, "未提供决策依据。"));
  game.aiTraces.push({
    id: game.nextTraceId++,
    day: game.day,
    phase: game.phase,
    playerId: player.id,
    role: player.role,
    kind,
    source,
    action: describeDecision(kind, decision),
    reasoningSummary: reasoningSummary(decision.reasoningSummary, "未提供决策依据。"),
    communicationIntent: decision.communicationIntent || null,
    disclosureMode: decision.disclosureMode || null,
    pressureLevel: decision.pressureLevel || null,
    targetIds: decision.targetIds || [],
    expectedReaction: decision.expectedReaction || null,
    speechActs: normalizeSpeechActs(decision.speechActs),
    speechAuditWarnings: Array.isArray(decision.speechAuditWarnings) ? decision.speechAuditWarnings.slice(0, 6) : [],
    modelOverride: decision.modelOverride || null,
    situationAudit: decision.situationAudit || null,
    strategyPlan: serializeStrategyPlan(decision.strategyPlan)
  });
  if (game.aiTraces.length > 80) game.aiTraces.shift();
}

function aiProcessKind(kind) {
  return { speech: "公开发言", wolf: "狼人刀口", seer: "预言家查验", witch: "女巫用药", vote: "放逐投票" }[kind] || kind;
}

function renderAIProcess() {
  if (!game?.debugMode) return "";
  const process = game?.liveAIProcess || game?.lastAIProcess;
  if (!process) return "";
  const live = Boolean(game.liveAIProcess);
  const source = process.source || "线上模型";
  const stage = process.stage || (live ? "正在生成结构化决策" : "已完成");
  const summary = process.summary
    ? `<p class="ai-process-summary"><strong>公开依据：</strong>${escapeHtml(process.summary)}</p>`
    : "";
  const tokenNote = process.reasoningTokens ? ` · 推理 ${process.reasoningTokens} tokens` : "";
  return `<section class="ai-process${live ? " is-live" : ""}"><div class="ai-process-head"><strong>${escapeHtml(source)}</strong><span>${escapeHtml(aiProcessKind(process.kind))}${tokenNote}</span></div><div class="ai-process-stage">${escapeHtml(stage)}</div>${summary}<small>仅展示结构化决策依据，不展示隐藏思维链或私密身份信息。</small></section>`;
}

function validateSpeechContext(speech, player, extra = {}) {
  if (!extra.lastWords) return { ok: true, text: speech };
  const text = String(speech || "").trim();
  if (!/(我|自己).*(出局|放逐)|(?:出局|放逐).*(我|自己)/.test(text)) {
    return { ok: false, reason: "放逐遗言必须明确承认自己已经出局" };
  }
  if (/(我不把|不能把|不要把).*(出局|放逐).*(身份|结论|查验)/.test(text)) {
    return { ok: false, reason: "遗言不能把自己的出局当成普通桌面结论来讨论" };
  }
  if (/(我想听|请\s*[1-6]?号?.*(解释|说明|回应)|下一轮我|接下来我)/.test(text)) {
    return { ok: false, reason: "遗言不能继续以存活玩家身份追问或安排自己的后续行动" };
  }
  return { ok: true, text };
}

function validateAIPublicSpeechEnvelope(speech) {
  const raw = String(speech || "").trim();
  if (!raw) return { ok: false, reason: "公开发言不能为空" };
  if (raw.length > 180) return { ok: false, reason: "公开发言不能超过180字" };
  return { ok: true, text: sanitizePublicSpeech(raw, game.players) };
}

function validateAIPublicSpeech(speech, player, extra = {}) {
  const syntaxCheck = validateAIPublicSpeechEnvelope(speech);
  if (!syntaxCheck.ok) return syntaxCheck;
  const warnings = [];
  if (player.role === "seer") {
    const claim = seerClaim(player);
    const seerCheck = validateSeerSpeech(syntaxCheck.text, {
      speakerSeat: player.seat + 1,
      requireAll: false,
      checks: (claim?.checks || []).map((check) => ({
        targetSeat: playerById(check.targetId)?.seat + 1,
        faction: check.faction
      }))
    });
    if (!seerCheck.ok) warnings.push(seerCheck.reason);
  }
  if (player.role === "witch") {
    const poisonTarget = playerById(game.night.witchAction?.targetId);
    const witchCheck = validateWitchSpeech(syntaxCheck.text, {
      killTargetSeat: playerById(game.night.wolfTarget)?.seat + 1 || null,
      action: game.night.witchAction?.action || null,
      poisonTargetSeat: poisonTarget ? poisonTarget.seat + 1 : null
    });
    if (!witchCheck.ok) warnings.push(witchCheck.reason);
  }
  const evidenceCheck = validatePublicSpeechEvidence(syntaxCheck.text, {
    speakerSeat: player.seat + 1,
    speakerRole: player.role,
    publicEvents: game.events,
    allowDeception: player.role === "werewolf"
  });
  if (!evidenceCheck.ok) warnings.push(evidenceCheck.reason);
  const semanticText = evidenceCheck.ok ? evidenceCheck.text : syntaxCheck.text;
  const targetCheck = validateSpeechTargets(semanticText, {
    aliveSeats: alivePlayers().map((item) => item.seat + 1)
  });
  if (!targetCheck.ok) warnings.push(targetCheck.reason);
  const contextCheck = validateSpeechContext(targetCheck.ok ? targetCheck.text : semanticText, player, extra);
  if (!contextCheck.ok) warnings.push(contextCheck.reason);
  return { ok: true, text: syntaxCheck.text, warnings };
}

function prepareAIDecision(player, kind, decision, extra, candidates = []) {
  const situation = evaluateSituation({
    players: game.players,
    phase: game.phase,
    day: game.day,
    night: game.night,
    witch: game.witch,
    legalActions: candidates.map((targetId) => ({ type: kind, targetId }))
  });
  const strategyPlan = planStrategy({
    kind,
    action: decision.action,
    targetId: decision.targetId,
    legalTargets: candidates,
    reasoningSummary: decision.reasoningSummary,
    communicationIntent: decision.communicationIntent,
    disclosureMode: decision.disclosureMode,
    pressureLevel: decision.pressureLevel,
    targetIds: decision.targetIds,
    expectedReaction: decision.expectedReaction,
    evidence: decision.evidence
  });
  const situationAudit = {
    wolfWinDistance: situation.wolfWinDistance,
    villageWinDistance: situation.villageWinDistance,
    winner: situation.winner,
    branchCount: situation.branchCount,
    terminalBranchCount: situation.terminalBranchCount
  };
  if (kind !== "speech") return { ...decision, strategyPlan, situationAudit };
  if (decision.action === "explode") return { ...decision, strategyPlan, situationAudit, ...normalizeSpeechMetadata(player, decision, extra) };
  const speechActPlan = prepareSpeechActs(player, decision);
  const speechCheck = validateAIPublicSpeech(decision.speech, player, extra);
  const roleClaims = new Set(speechActPlan.acts
    .filter((act) => act.type === SPEECH_ACT_TYPES.ROLE_CLAIM)
    .map((act) => act.role));
  const missingStructuredRoleClaim = (isSeerClaimText(decision.speech) && !roleClaims.has("seer"))
    || (isExplicitWitchClaim(decision.speech) && !roleClaims.has("witch"));
  const delivery = resolveSpeechDelivery({
    hardError: speechCheck.ok ? null : speechCheck.reason,
    structuredErrors: speechActPlan.warnings,
    missingStructuredRoleClaim,
    semanticWarnings: speechCheck.warnings || [],
    acceptedActs: speechActPlan.acts
  });
  const shouldUseFallback = delivery.reject || delivery.useFallback;
  const sourceSpeech = shouldUseFallback
    ? "我只根据公开发言和票型判断，请各位明确站边。"
    : speechCheck.text;
  const generated = generateSpeechFromPlan(strategyPlan, sourceSpeech, {
    validateSpeech: validateAIPublicSpeechEnvelope
  });
  const speechActs = shouldUseFallback ? [] : speechActPlan.acts;
  const speechAuditWarnings = [
    ...speechActPlan.warnings,
    ...(speechCheck.warnings || []),
    ...(missingStructuredRoleClaim ? ["正文包含身份声明，但模型没有提供对应的结构化发言动作"] : [])
  ];
  return {
    ...decision,
    speech: generated.speech,
    speechActs,
    speechAuditWarnings,
    strategyPlan,
    situationAudit,
    ...normalizeSpeechMetadata(player, { ...decision, speech: generated.speech, speechActs }, extra)
  };
}

async function getAIDecision(player, kind, candidates, extra = {}) {
  const operation = captureGameOperation();
  const gameState = operation.game;
  gameState.debugProgress = `${kind}:begin:${player.id}`;
  if (!hasOnlineAIConfig()) throw new Error("线上 AI 配置不完整，请打开模型设置并测试连接");
  gameState.liveAIProcess = {
    playerId: player.id,
    kind,
    source: "线上模型",
    stage: "已读取公开发言、票型和死亡信息；正在生成结构化决策",
    summary: ""
  };
  renderActionPanel();
  try {
    updateModelStatus(`线上 AI · ${seatLabel(player.id)}思考中`);
    const onlineDecision = await callOnlineModel(player, kind, candidates, extra, operation);
    assertGameOperation(operation);
    const decision = prepareAIDecision(player, kind, onlineDecision, extra, candidates);
    gameState.metrics.modelSuccesses += 1;
    gameState.metrics.lastError = "";
    gameState.lastAIProcess = {
      ...gameState.liveAIProcess,
      source: "线上模型",
      stage: "已完成：动作通过规则校验",
      summary: decision.reasoningSummary,
      reasoningTokens: decision.modelMeta?.reasoningTokens || 0
    };
    gameState.liveAIProcess = null;
    recordAITrace(player, kind, decision, "线上模型");
    updateModelStatus("线上 AI 已连接");
    return decision;
  } catch (error) {
    if (isStaleGameRunError(error) || !gameRuns.isCurrent(operation.run) || game !== gameState) {
      throw new StaleGameRunError(operation.run.gameId);
    }
    recordErrorLog({ source: "online-ai", error, playerId: player.id, kind, diagnostic: error?.diagnostic });
    gameState.metrics.modelFailures += 1;
    gameState.metrics.lastError = error?.message || "模型请求失败";
    gameState.lastAIProcess = {
      ...gameState.liveAIProcess,
      source: "线上模型",
      stage: `请求失败，对局已暂停：${error?.message || "未知错误"}`,
      summary: "未使用本地 Bot 继续对局。"
    };
    gameState.liveAIProcess = null;
    updateModelStatus("线上 AI 失败，对局已暂停");
    throw error;
  }
}

function roleDescription(player) {
  if (game.phase === "ended") return `${ROLES[player.role].name} · ${ROLES[player.role].faction === "werewolf" ? "狼人阵营" : "好人阵营"}`;
  if (game.revealedRoles.includes(player.id)) return `${ROLES[player.role].name} · 身份已公开`;
  if (game.debugMode) return `${ROLES[player.role].name} · 开发视图`;
  const human = humanPlayer();
  if (human.role === "werewolf" && player.role === "werewolf" && player.id !== human.id) return "狼队友";
  if (player.controller === "human") return ROLES[player.role].name;
  return player.alive ? "身份未知" : "身份未公开";
}

function renderTable() {
  tableStage.querySelectorAll(".seat").forEach((node) => node.remove());
  const human = humanPlayer();
  const activeActorVisible = canExposeActiveActor({
    phase: game.phase,
    debugMode: game.debugMode,
    activePlayerId: speakingPlayerId
  });
  for (const player of game.players) {
    const isWolfTeammate = human.role === "werewolf" && player.role === "werewolf" && player.id !== human.id;
    const node = document.createElement("button");
    node.type = "button";
    node.className = `seat${player.controller === "human" ? " is-you" : ""}${isWolfTeammate ? " is-teammate" : ""}${player.alive ? "" : " is-dead"}${activeActorVisible && speakingPlayerId === player.id ? " is-speaking" : ""}${pendingHuman?.candidates?.includes(player.id) ? " seat-selectable" : ""}`;
    node.dataset.seat = String(player.seat);
    node.disabled = !pendingHuman?.candidates?.includes(player.id);
    const visibleName = game.debugMode ? player.name : `${player.seat + 1}号座位`;
    node.innerHTML = `<span class="seat-avatar">${player.seat + 1}</span><span class="seat-info"><span class="seat-name">${escapeHtml(visibleName)}</span><span class="seat-meta">${escapeHtml(roleDescription(player))}</span></span><span class="seat-state">${player.alive ? "存活" : "出局"}</span>`;
    if (pendingHuman?.candidates?.includes(player.id)) node.addEventListener("click", () => { selectedTarget = player.id; renderActionPanel(); renderTable(); });
    if (selectedTarget === player.id) node.classList.add("selected");
    tableStage.appendChild(node);
  }
}

function renderTimeline() {
  if (!game) return;
  const replayEvents = game.replayMode ? game.events.slice(0, game.replayCursor) : game.events;
  if (!replayEvents.length) {
    timeline.innerHTML = '<div class="empty-log">桌面还没有公开事件</div>';
    return;
  }
  timeline.innerHTML = replayEvents.slice(-50).map((event) => `<article class="event event-${escapeHtml(event.kind)}"><div class="event-meta"><strong>${escapeHtml(event.actor)}</strong><span>第 ${event.day} 天</span></div><div class="event-copy">${event.kind === "speech" ? '<span class="quote">“</span>' : ""}${escapeHtml(event.text)}${event.kind === "speech" ? '<span class="quote">”</span>' : ""}</div></article>`).join("");
  requestAnimationFrame(() => { timeline.scrollTop = timeline.scrollHeight; });
}

function renderRoleCard() {
  const human = humanPlayer();
  const privateNotes = [];
  if (human.role === "werewolf") {
    const teammate = game.players.find((player) => player.role === "werewolf" && player.id !== human.id);
    privateNotes.push(`队友：${seatLabel(teammate.id)}`);
  }
  if (human.role === "seer") privateNotes.push(...game.privateEvents.slice(-2).map((event) => event.text));
  if (human.role === "witch") privateNotes.push(`解药：${game.witch.saveAvailable ? "可用" : "已用"} · 毒药：${game.witch.poisonAvailable ? "可用" : "已用"}`);
  if (human.role === "werewolf" && game.wolfRoom.plan) privateNotes.push(`狼队计划：${game.wolfRoom.plan.summary}`);
  roleCard.innerHTML = `<span class="role-label">PRIVATE ROLE</span><div class="role-name">${escapeHtml(ROLES[human.role].name)}</div><p class="role-desc">${escapeHtml(ROLES[human.role].description)}${privateNotes.length ? `<br>${privateNotes.map(escapeHtml).join("<br>")}` : ""}</p>`;
}

function renderWolfRoom() {
  const planSummary = game.wolfRoom.plan?.summary;
  const currentMessages = game.wolfRoom.messages
    .filter((message) => message.day === game.day && message.text !== planSummary)
    .slice(-4);
  if (!currentMessages.length && !game.wolfRoom.plan) {
    return '<section class="wolf-room"><div class="wolf-room-title">狼队私聊</div><p>本夜暂时还没有队友提案，你将先提交刀口。</p></section>';
  }
  const messages = currentMessages.map((message) => `<div class="wolf-message"><strong>${escapeHtml(seatLabel(message.speakerId))}</strong><span>${escapeHtml(message.text)}</span></div>`).join("");
  return `<section class="wolf-room"><div class="wolf-room-title">狼队私聊</div>${messages}${game.wolfRoom.plan ? `<p class="wolf-plan">${escapeHtml(game.wolfRoom.plan.summary)}</p>` : ""}</section>`;
}

function renderErrorLogEntry(entry, compact = false) {
  if (!entry) return '<div class="debug-empty">暂无错误日志。</div>';
  const player = entry.playerId ? playerById(entry.playerId) : null;
  const meta = [
    entry.at ? String(entry.at).replace("T", " ").replace("Z", "") : "未知时间",
    entry.source || "runtime",
    player ? seatLabel(player.id) : null,
    entry.kind,
    entry.day ? `第${entry.day}天` : null,
    entry.phase
  ].filter(Boolean).join(" · ");
  const diagnostic = entry.diagnostic ? `<div class="debug-error-diagnostic">${escapeHtml(entry.diagnostic)}</div>` : "";
  const stack = !compact && entry.stack ? `<pre class="debug-error-stack">${escapeHtml(entry.stack)}</pre>` : "";
  return `<article class="debug-error"><div class="debug-error-meta">${escapeHtml(meta)}</div><div class="debug-error-message">${escapeHtml(entry.message || "未知错误")}</div>${diagnostic}${stack}</article>`;
}

function renderDeveloperPanel() {
  const toggle = el("toggle-developer");
  toggle.setAttribute("aria-pressed", String(game.debugMode));
  toggle.textContent = `开发模式：${game.debugMode ? "开" : "关"}`;
  developerPanel.classList.toggle("hidden", !game.debugMode);
  if (!game.debugMode) return;
  el("debug-roster").innerHTML = game.players.map((player) => `<div class="debug-player"><span class="debug-seat">${player.seat + 1}</span><span class="debug-player-name">${escapeHtml(player.name)}</span><span class="debug-role role-${player.role}">${escapeHtml(ROLES[player.role].name)}</span><span class="debug-state${player.alive ? "" : " is-dead"}">${player.alive ? "存活" : "出局"}</span></div>`).join("");
  const traces = game.aiTraces.slice(-40).reverse();
  el("debug-traces").innerHTML = traces.length ? traces.map((trace) => {
    const player = playerById(trace.playerId);
    const social = trace.communicationIntent
      ? `<div class="trace-social">意图 ${escapeHtml(trace.communicationIntent)} · 披露 ${escapeHtml(trace.disclosureMode || "withhold")} · 压力 ${escapeHtml(trace.pressureLevel || "low")}</div>`
      : "";
    const strategy = trace.strategyPlan
      ? `<div class="trace-strategy">策略 ${escapeHtml(trace.strategyPlan.kind)} · ${escapeHtml(trace.strategyPlan.action || "保留")}${trace.strategyPlan.targetId ? ` · 目标 ${escapeHtml(seatLabel(trace.strategyPlan.targetId))}` : ""}</div>`
      : "";
    const situation = trace.situationAudit
      ? `<div class="trace-social">局势：狼胜距${trace.situationAudit.wolfWinDistance} · 好人胜距${trace.situationAudit.villageWinDistance} · 合法分支${trace.situationAudit.branchCount}</div>`
      : "";
    const speechActs = trace.speechActs?.length
      ? `<div class="trace-strategy">发言动作：${escapeHtml(trace.speechActs.map((act) => act.type).join("、"))}</div>`
      : "";
    const speechWarnings = trace.speechAuditWarnings?.length
      ? `<div class="trace-reason">软审计：${escapeHtml(trace.speechAuditWarnings.join("；"))}</div>`
      : "";
    return `<article class="debug-trace"><div class="trace-meta"><strong>${player.seat + 1}号 ${escapeHtml(player.name)}</strong>${escapeHtml(ROLES[trace.role].name)} · 第${trace.day}天<br>${escapeHtml(trace.source)}</div><div class="trace-action"><div>${escapeHtml(trace.action)}</div>${strategy}${social}${situation}${speechActs}<div class="trace-reason">依据：${escapeHtml(trace.reasoningSummary)}</div>${speechWarnings}</div></article>`;
  }).join("") : '<div class="debug-empty">AI 尚未产生决策记录。</div>';
  const planSummary = game.wolfRoom.plan?.summary;
  const wolfMessages = game.wolfRoom.messages
    .filter((message) => message.text !== planSummary)
    .slice(-12)
    .map((message) => `<div class="debug-wolf-message"><strong>${escapeHtml(seatLabel(message.speakerId))} · 第${message.day}夜</strong><span>${escapeHtml(message.text)}</span></div>`).join("");
  el("debug-wolf-room").innerHTML = wolfMessages || '<div class="debug-empty">狼队尚未产生私聊或提案。</div>';
  if (game.wolfRoom.plan) el("debug-wolf-room").innerHTML += `<div class="debug-wolf-plan">${escapeHtml(game.wolfRoom.plan.summary)}</div>`;
  const memoryCards = game.players.filter((player) => player.controller === "ai").map((player) => {
    const memory = game.agentMemories[player.id];
    const beliefs = Object.entries(memory.beliefs).filter(([id]) => id !== player.id).sort(([, left], [, right]) => right.suspicion - left.suspicion).slice(0, 3)
      .map(([id, belief]) => `${escapeHtml(seatLabel(id))} ${Math.round(belief.suspicion)}`).join(" · ");
    const privateCount = memory.privateEvents.length;
    const claimCount = memory.claims.length;
    return `<article class="debug-memory"><div class="debug-memory-head"><strong>${escapeHtml(seatLabel(player.id))}</strong><span>${escapeHtml(ROLES[player.role].name)} · 公开${memory.publicEvents.length} · 私密${privateCount} · 声明${claimCount}</span></div><div class="debug-memory-beliefs">狼坑候选：${beliefs || "暂无"}</div><div class="debug-memory-analysis">二阶${memory.secondOrderBeliefs.length} · 动机${memory.motiveAnalyses.length} · 发言意图${memory.communicationLog.length}</div><div class="debug-memory-reason">最近依据：${escapeHtml(memory.lastReasoningSummary || "暂无")}</div></article>`;
  }).join("");
  el("debug-memories").innerHTML = memoryCards || '<div class="debug-empty">尚未创建 AI 认知快照。</div>';
  const errorLogs = (game.errorLog || []).slice().reverse();
  el("debug-errors").innerHTML = errorLogs.length ? errorLogs.map((entry) => renderErrorLogEntry(entry)).join("") : '<div class="debug-empty">暂无错误日志。</div>';
  const metrics = game.metrics || {};
  const modelAudit = `<div class="debug-invariant">模型调用 ${metrics.modelCalls || 0} · 成功 ${metrics.modelSuccesses || 0} · 重试 ${metrics.modelRetries || 0} · 失败 ${metrics.modelFailures || 0}${metrics.lastError ? ` · 最近错误：${escapeHtml(metrics.lastError)}` : ""}</div>`;
  el("debug-invariants").innerHTML = modelAudit + (game.invariantErrors.length
    ? game.invariantErrors.map((error) => `<div class="debug-invariant error">${escapeHtml(error)}</div>`).join("")
    : `<div class="debug-invariant ok">当前状态满足已注册规则不变量。</div><div class="debug-invariant">运行进度：${escapeHtml(game.debugProgress || "空闲")}</div>`);
}

function targetButtons(candidates) {
  return `<div class="target-list">${candidates.map((id) => { if (id === ABSTAIN) return `<button type="button" class="target-button abstain-button${selectedTarget === id ? " selected" : ""}" data-target="${id}"><span>弃票</span><small>不投给任何玩家</small></button>`; const player = playerById(id); return `<button type="button" class="target-button${selectedTarget === id ? " selected" : ""}" data-target="${id}"><span>${seatLabel(player.id)}</span><small>${player.alive ? "存活" : "出局"}</small></button>`; }).join("")}</div>`;
}

function bindTargetButtons() {
  actionContent.querySelectorAll("[data-target]").forEach((button) => button.addEventListener("click", () => {
    selectedTarget = button.dataset.target;
    renderActionPanel();
    renderTable();
  }));
}

function renderActionPanel() {
  if (!game) return;
  if (game.replayMode) {
    const total = game.events.length;
    const cursor = Math.min(total, Math.max(0, game.replayCursor));
    const current = cursor ? game.events[cursor - 1] : null;
    const returnLabel = game.replayReturnState ? "返回当前对局" : "返回大厅";
    actionContent.innerHTML = `<div class="result-box replay-box"><strong>回放模式</strong><p>原局 ${game.replaySourcePhase || "未知阶段"} · 已显示 ${cursor}/${total} 个公开事件。</p>${current ? `<p class="replay-current">当前事件：${escapeHtml(current.actor)} · ${escapeHtml(current.text)}</p>` : ""}</div><div class="replay-controls"><button class="quiet-button" id="replay-prev" type="button" ${cursor ? "" : "disabled"}>上一步</button><button class="quiet-button" id="replay-next" type="button" ${cursor < total ? "" : "disabled"}>下一步</button><button class="quiet-button" id="replay-all" type="button" ${cursor === total ? "disabled" : ""}>显示全部</button></div><button type="button" class="primary-button action-submit" id="restart-action">${returnLabel} <span>→</span></button>`;
    el("replay-prev").addEventListener("click", () => { game.replayCursor = Math.max(0, cursor - 1); render(); });
    el("replay-next").addEventListener("click", () => { game.replayCursor = Math.min(total, cursor + 1); render(); });
    el("replay-all").addEventListener("click", () => { game.replayCursor = total; render(); });
    el("restart-action").addEventListener("click", exitReplay);
    return;
  }
  if (game.phase === "ended") {
    const winner = game.winner === "village" ? "好人阵营获胜" : "狼人阵营获胜";
    actionContent.innerHTML = `<div class="result-box"><strong>${winner}</strong><p>完整身份已经在桌面座位上揭示。可以复盘公开记录，或重新开一局测试其他身份。</p></div><button type="button" class="primary-button action-submit" id="restart-action">重新开局 <span>→</span></button>`;
    el("restart-action").addEventListener("click", returnToLobby);
    return;
  }
  if (game.error) {
    const latestError = game.debugMode && game.errorLog?.length
      ? `<div class="debug-error-inline"><strong>最近错误日志</strong>${renderErrorLogEntry(game.errorLog[game.errorLog.length - 1], true)}</div>`
      : "";
    const errorTitle = game.debugMode ? "线上 AI 请求失败" : "本局已暂停";
    const errorMessage = game.debugMode && game.errorDetail ? game.errorDetail : "线上 AI 暂时无法完成当前行动，请重新开局。";
    actionContent.innerHTML = `<div class="result-box"><strong>${errorTitle}</strong><p>${escapeHtml(errorMessage)}</p><p>未切换到本地 Bot。</p>${latestError}</div><button type="button" class="quiet-button action-submit" id="open-model-settings">打开模型设置</button><button type="button" class="primary-button action-submit" id="restart-action">重新开局 <span>→</span></button>`;
    el("open-model-settings").addEventListener("click", () => settingsDialog.showModal());
    el("restart-action").addEventListener("click", returnToLobby);
    return;
  }
  if (!pendingHuman) {
    const thinking = publicWaitingText({
      phase: game.phase,
      activePlayerLabel: canExposeActiveActor({
        phase: game.phase,
        debugMode: game.debugMode,
        activePlayerId: speakingPlayerId
      }) ? seatLabel(speakingPlayerId) : ""
    });
    actionContent.innerHTML = `<p class="action-kicker">WAITING</p><h3 class="action-title">等待桌面行动</h3><p class="action-help">AI 会依次完成发言、技能或投票。轮到你时，操作会自动出现在这里。</p><div class="ai-thinking">${escapeHtml(thinking)}</div>${renderAIProcess()}`;
    return;
  }
  if (pendingHuman.kind === "speech") {
    const explodeButton = pendingHuman.canExplode ? '<button class="quiet-button danger-button action-submit" id="explode-wolf" type="button">自爆并结束白天</button>' : "";
    actionContent.innerHTML = `<form class="speech-form" id="speech-form"><p class="action-kicker">YOUR TURN</p><h3 class="action-title">轮到你发言</h3><p class="action-help">发言会成为公开记录。可以质疑、报身份或给出你的狼坑。</p><textarea id="speech-input" maxlength="180" placeholder="输入你的发言…" required></textarea><button class="primary-button action-submit" type="submit">提交发言 <span>→</span></button>${explodeButton}</form>`;
    el("speech-form").addEventListener("submit", (event) => { event.preventDefault(); submitHuman({ speech: el("speech-input").value }); });
    el("explode-wolf")?.addEventListener("click", () => submitHuman({ action: "explode" }));
    return;
  }
  if (pendingHuman.kind === "duel_speech") {
    actionContent.innerHTML = `<form class="speech-form" id="speech-form"><p class="action-kicker">DUEL SPEECH</p><h3 class="action-title">轮到并列玩家陈述</h3><p class="action-help">这是公开的最后陈述，之后只会在并列玩家中进行重投。</p><textarea id="speech-input" maxlength="180" placeholder="输入你的最后陈述…" required></textarea><button class="primary-button action-submit" type="submit">提交陈述 <span>→</span></button></form>`;
    el("speech-form").addEventListener("submit", (event) => { event.preventDefault(); submitHuman({ speech: el("speech-input").value }); });
    return;
  }
  if (pendingHuman.kind === "last_words") {
    actionContent.innerHTML = `<form class="speech-form" id="speech-form"><p class="action-kicker">LAST WORDS</p><h3 class="action-title">留下遗言</h3><p class="action-help">放逐已经完成，遗言会公开记录，但不会改变本次结果。</p><textarea id="speech-input" maxlength="180" placeholder="输入你的遗言…" required></textarea><button class="primary-button action-submit" type="submit">提交遗言 <span>→</span></button></form>`;
    el("speech-form").addEventListener("submit", (event) => { event.preventDefault(); submitHuman({ speech: el("speech-input").value }); });
    return;
  }
  if (pendingHuman.kind === "witch") {
    const killed = playerById(pendingHuman.killTargetId);
    actionContent.innerHTML = `<p class="action-kicker">WITCH ACTION</p><h3 class="action-title">选择一种行动</h3><p class="action-help">今晚狼刀指向 ${killed ? seatLabel(killed.id) : "无人"}。同一夜只能使用一瓶药。</p>${game.witch.poisonAvailable ? targetButtons(pendingHuman.candidates) : ""}<div class="target-list action-submit">${game.witch.saveAvailable && killed ? '<button type="button" class="target-button" id="witch-save"><span>使用解药</span><small>救下狼刀目标</small></button>' : ""}${game.witch.poisonAvailable ? '<button type="button" class="target-button" id="witch-poison"><span>使用毒药</span><small>需先选择目标</small></button>' : ""}<button type="button" class="target-button" id="witch-pass"><span>不用药</span><small>保留药水</small></button></div>`;
    bindTargetButtons();
    el("witch-save")?.addEventListener("click", () => submitHuman({ action: "save" }));
    el("witch-poison")?.addEventListener("click", () => { if (selectedTarget) submitHuman({ action: "poison", targetId: selectedTarget }); });
    el("witch-pass").addEventListener("click", () => submitHuman({ action: "pass" }));
    return;
  }
  if (pendingHuman.kind === "wolf") {
    const help = "与你的队友共同决定今晚的目标；目标可以是任意存活座位。";
    actionContent.innerHTML = `<p class="action-kicker">WOLF ACTION</p><h3 class="action-title">选择刀口</h3><p class="action-help">${help}</p>${renderWolfRoom()}${targetButtons(pendingHuman.candidates)}<button class="primary-button action-submit" id="submit-target" type="button" ${selectedTarget ? "" : "disabled"}>确认选择 <span>→</span></button>`;
    bindTargetButtons();
    el("submit-target").addEventListener("click", () => { if (selectedTarget) submitHuman({ targetId: selectedTarget }); });
    return;
  }
  const labels = { wolf: ["WOLF ACTION", "选择刀口", "与你的队友共同决定今晚的目标。"], seer: ["SEER CHECK", "选择查验目标", "查验结果只对你可见。"], vote: ["YOUR VOTE", game.phase === "vote_retry" ? "平票重投" : "选择放逐目标", "不能投自己；可以弃票，票型会在所有人完成后公开。"] };
  const [kicker, title, help] = labels[pendingHuman.kind];
  actionContent.innerHTML = `<p class="action-kicker">${kicker}</p><h3 class="action-title">${title}</h3><p class="action-help">${help}</p>${targetButtons(pendingHuman.candidates)}<button class="primary-button action-submit" id="submit-target" type="button" ${selectedTarget ? "" : "disabled"}>确认选择 <span>→</span></button>`;
  bindTargetButtons();
  el("submit-target").addEventListener("click", () => { if (selectedTarget) submitHuman({ targetId: selectedTarget }); });
}

function render() {
  refreshInvariantState();
  updateModelStatus();
  if (!game) return;
  const phase = PHASES[game.phase];
  el("phase-eyebrow").textContent = `${phase[0]} ${String(game.day).padStart(2, "0")}`;
  el("phase-title").textContent = phase[1];
  el("table-core-title").textContent = phase[2];
  el("table-core-subtitle").textContent = phase[3];
  el("round-badge").textContent = `${game.phase.startsWith("night") ? "第" : "第"} ${game.day} ${game.phase.startsWith("night") ? "夜" : "天"}`;
  el("alive-count").textContent = `${alivePlayers().length}/6`;
  el("game-seed-label").textContent = String(game.seed);
  renderTable();
  renderTimeline();
  renderRoleCard();
  renderActionPanel();
  renderDeveloperPanel();
}

function returnToLobby() {
  gameRuns.cancel();
  activeGameRun = null;
  advancing = false;
  simulationMode = false;
  lastInvariantSignature = "";
  game = null;
  pendingHuman = null;
  selectedTarget = null;
  speakingPlayerId = null;
  gameScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  updateModelStatus("本地引擎就绪");
}

el("start-form").addEventListener("submit", (event) => {
  event.preventDefault();
  appPreferences.developerMode = el("developer-mode").checked;
  saveStoredObject(APP_PREFERENCES_KEY, appPreferences);
  startGame(el("player-name").value.trim(), el("role-mode").value, true, appPreferences.developerMode, el("game-seed").value.trim() || null);
});
el("new-game").addEventListener("click", returnToLobby);
el("export-replay").addEventListener("click", () => {
  if (!game) return;
  const replay = {
    version: 1,
    exportedAt: new Date().toISOString(),
    gameId: game.id,
    seed: game.seed,
    day: game.day,
    phase: game.phase,
    winner: game.winner,
    players: game.players.map(({ id, seat, name, role, alive, controller, persona }) => ({ id, seat, name, role, alive, controller, persona })),
    events: game.events,
    aiTraces: game.aiTraces,
    privateEvents: game.privateEvents,
    publicClaims: game.publicClaims,
    errorLog: game.errorLog,
    claimGraph: game.claimGraph,
    agentMemories: Object.fromEntries(Object.entries(game.agentMemories).map(([id, memory]) => [id, snapshotMemory(memory)])),
    wolfRoom: game.wolfRoom
  };
  const blob = new Blob([JSON.stringify(replay, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `night-watch-${game.seed}.json`;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 0);
});
function loadReplayDocument(replay) {
  const errors = validateReplayDocument(replay);
  if (errors.length) throw new Error(errors[0]);
  if (advancing) throw new Error("请等当前 AI 行动完成后再导入回放");
  const replayReturnState = game ? { game, pendingHuman, selectedTarget, speakingPlayerId, modelStatus } : null;
  const players = replay.players.map((player) => ({ ...player, alive: Boolean(player.alive) }));
  const memories = replay.agentMemories && typeof replay.agentMemories === "object" ? replay.agentMemories : {};
  const replayGame = {
    id: String(replay.gameId),
    seed: Number(replay.seed) || 0,
    random: createRng(Number(replay.seed) || 0),
    day: Number(replay.day) || 1,
    phase: "ended",
    replaySourcePhase: String(replay.phase || "unknown"),
    replayMode: true,
    replayReturnState,
    replayCursor: 0,
    players,
    events: [...replay.events],
    privateEvents: Array.isArray(replay.privateEvents) ? [...replay.privateEvents] : [],
    publicClaims: Array.isArray(replay.publicClaims) ? [...replay.publicClaims] : [],
    claimGraph: replay.claimGraph || createClaimGraph(),
    agentMemories: Object.fromEntries(players.map((player) => [player.id, memories[player.id] || createAgentMemory({ gameId: String(replay.gameId), player, players })])),
    aiTraces: Array.isArray(replay.aiTraces) ? [...replay.aiTraces] : [],
    seerKnowledge: {},
    witch: { saveAvailable: true, poisonAvailable: true },
    wolfRoom: replay.wolfRoom || { messages: [], proposals: [], plan: null },
    night: {},
    discussionIndex: 0,
    duelIndex: 0,
    lastWordsPlayerId: null,
    votes: {},
    voteIndex: 0,
    tieCandidates: [],
    winner: replay.winner || null,
    nextEventId: replay.events.length + 1,
    nextPrivateEventId: 1,
    nextTraceId: replay.aiTraces?.length + 1 || 1,
    nextErrorId: (Array.isArray(replay.errorLog) ? replay.errorLog.length : 0) + 1,
    errorLog: Array.isArray(replay.errorLog) ? replay.errorLog : [],
    onlineAI: true,
    debugMode: Boolean(appPreferences.developerMode),
    revealedRoles: players.map((player) => player.id),
    ended: true,
    error: null,
    errorDetail: null,
    invariantErrors: [],
    phaseHistory: [{ day: Number(replay.day) || 1, phase: "ended" }],
    maxDays: 30,
    actionCount: 0
  };
  activeGameRun = gameRuns.begin(replayGame.id);
  game = replayGame;
  advancing = false;
  lastInvariantSignature = "";
  pendingHuman = null;
  selectedTarget = null;
  speakingPlayerId = null;
  lobbyScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  game.replayCursor = game.events.length;
  updateModelStatus("已载入本地回放");
  render();
}

function exitReplay() {
  if (!game?.replayMode) return returnToLobby();
  const previous = game.replayReturnState;
  if (!previous) return returnToLobby();
  activeGameRun = gameRuns.begin(previous.game.id);
  game = previous.game;
  advancing = false;
  pendingHuman = previous.pendingHuman;
  selectedTarget = previous.selectedTarget;
  speakingPlayerId = previous.speakingPlayerId;
  modelStatus = previous.modelStatus;
  updateModelStatus();
  render();
}

el("import-replay").addEventListener("click", () => el("replay-file").click());
el("replay-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    loadReplayDocument(JSON.parse(await file.text()));
  } catch (error) {
    updateModelStatus(`回放导入失败：${error?.message || "文件格式错误"}`);
  }
});
el("toggle-developer").addEventListener("click", () => {
  if (!game) return;
  game.debugMode = !game.debugMode;
  appPreferences.developerMode = game.debugMode;
  el("developer-mode").checked = game.debugMode;
  saveStoredObject(APP_PREFERENCES_KEY, appPreferences);
  render();
});
el("run-simulation").addEventListener("click", async () => {
  if (simulationRunning) return;
  simulationRunning = true;
  const button = el("run-simulation");
  const status = el("simulation-status");
  const metrics = el("simulation-metrics");
  button.disabled = true;
  status.textContent = "线上 AI 模拟运行中...";
  metrics.textContent = "";
  try {
    const query = new URLSearchParams(window.location.search);
    const simulationCount = Math.max(1, Math.min(100, Number(query.get("simulationCount") || 100)));
    const simulationSeed = Math.max(1, Number(query.get("simulationSeed") || 1));
    const summary = await simulateMany(simulationCount, "random", simulationSeed);
    const failureCount = summary.failures.length;
    const firstFailure = summary.failures[0];
    const detail = firstFailure ? ` · 首个 ${firstFailure.seed}: ${firstFailure.invariantErrors[0] || "未结束"}` : "";
    status.textContent = `完成 ${summary.completed}/${simulationCount} · 失败 ${failureCount}${detail}`;
    const villageWins = summary.winners.village || 0;
    const wolfWins = summary.winners.werewolf || 0;
    metrics.textContent = `线上调用 ${summary.modelCalls} · 好人 ${villageWins} · 狼人 ${wolfWins} · 平均 ${summary.averageDays.toFixed(1)} 天 · AI动作 ${summary.averageAiActions.toFixed(1)}`;
  } catch (error) {
    status.textContent = `模拟失败：${error?.message || "未知错误"}`;
    metrics.textContent = "";
  } finally {
    simulationRunning = false;
    button.disabled = false;
  }
});
el("open-settings").addEventListener("click", () => {
  el("model-test-status").textContent = "";
  el("model-test-status").className = "model-test-status";
  settingsDialog.showModal();
});
el("temperature").addEventListener("input", () => { el("temperature-output").textContent = el("temperature").value; });
el("test-model").addEventListener("click", async () => {
  const button = el("test-model");
  const status = el("model-test-status");
  const setTestStatus = (message, tone = "") => {
    status.textContent = message;
    status.className = `model-test-status${tone ? ` ${tone}` : ""}`;
  };
  const reasoningEffort = el("reasoning-effort").value;
  const config = {
    dialect: el("api-dialect").value,
    baseUrl: el("base-url").value.trim(),
    endpointPath: el("endpoint-path").value.trim(),
    apiKey: el("api-key").value.trim(),
    model: el("model-name").value.trim(),
    temperature: 0,
    maxTokens: reasoningEffort === "high" ? 1000 : reasoningEffort === "medium" ? 700 : 400,
    reasoningEffort,
    stream: false,
    system: "你是连接测试助手。",
    messages: [{ role: "user", content: "只回复：连接正常" }]
  };
  if (!config.baseUrl || !config.model || !config.apiKey) {
    setTestStatus("测试失败：请先填写 Base URL、Model 和 API Key", "error");
    updateModelStatus("测试失败：配置不完整");
    return;
  }
  button.disabled = true;
  button.textContent = "连接中...";
  button.setAttribute("aria-busy", "true");
  setTestStatus(`正在连接 ${config.model}...`, "pending");
  try {
    const response = await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    });
    const raw = await response.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(`代理返回了不可解析的响应（HTTP ${response.status}）`);
    }
    if (!response.ok || !payload.text) throw new Error(payload.error || "模型没有返回最终答案");
    const reasoning = payload.reasoningTokens ? ` · 推理 ${payload.reasoningTokens} tokens` : "";
    setTestStatus(`连接成功：${config.model}${reasoning}`, "success");
    updateModelStatus(`模型连接成功 · ${config.model}${reasoning}`);
  } catch (error) {
    const message = error?.message || "未知错误";
    setTestStatus(`连接失败：${message}`, "error");
    updateModelStatus(`模型连接失败：${message}`);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = "测试连接";
  }
});
el("api-dialect").addEventListener("change", () => {
  const anthropic = el("api-dialect").value === "anthropic";
  el("endpoint-path").value = anthropic ? "/v1/messages" : "/chat/completions";
  const currentUrl = el("base-url").value.trim();
  if (anthropic && (!currentUrl || currentUrl === "https://api.deepseek.com")) {
    el("base-url").value = "https://api.deepseek.com/anthropic";
  } else if (!anthropic && currentUrl === "https://api.deepseek.com/anthropic") {
    el("base-url").value = "https://api.deepseek.com";
  }
});
el("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return settingsDialog.close();
  modelSettings.dialect = el("api-dialect").value;
  modelSettings.baseUrl = el("base-url").value.trim();
  modelSettings.endpointPath = el("endpoint-path").value.trim();
  modelSettings.model = el("model-name").value.trim();
  modelSettings.apiKey = el("api-key").value.trim();
  modelSettings.temperature = Number(el("temperature").value);
  modelSettings.reasoningEffort = el("reasoning-effort").value;
  const saved = saveStoredObject(MODEL_SETTINGS_KEY, modelSettings);
  updateModelStatus(saved ? (modelSettings.apiKey && modelSettings.model ? "线上 AI 配置已保存到本地" : "模型配置已保存，但尚未完整") : "浏览器拒绝本地存储");
  settingsDialog.close();
});

function fillSettingsForm() {
  el("api-dialect").value = modelSettings.dialect;
  el("base-url").value = modelSettings.baseUrl;
  el("endpoint-path").value = modelSettings.endpointPath;
  el("model-name").value = modelSettings.model;
  el("api-key").value = modelSettings.apiKey;
  el("reasoning-effort").value = modelSettings.reasoningEffort || "auto";
  el("temperature").value = String(modelSettings.temperature);
  el("temperature-output").textContent = String(modelSettings.temperature);
}

function simulationAction(pending) {
  if (pending.kind === "witch") return { action: "pass" };
  if (pending.kind === "speech" || pending.kind === "duel_speech" || pending.kind === "last_words") {
    return { speech: "我只根据公开发言和票型判断，请各位明确站边。" };
  }
  if (pending.kind === "vote") {
    const target = pending.candidates.find((id) => id !== ABSTAIN) || ABSTAIN;
    return { targetId: target };
  }
  return { targetId: pending.candidates[0] };
}

async function simulateGame(seed, role = "random", maxTicks = 12000) {
  if (!hasOnlineAIConfig()) throw new Error("线上 AI 配置不完整，不能运行模拟");
  simulationMode = true;
  startGame("测试玩家", role, true, true, seed);
  let ticks = 0;
  while (game && game.phase !== "ended" && ticks < maxTicks) {
    if (pendingHuman) {
      submitHuman(simulationAction(pendingHuman));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    ticks += 1;
  }
  const result = {
    seed: game?.seed ?? seed,
    phase: game?.phase || "missing",
    winner: game?.winner || null,
    day: game?.day || 0,
    ticks,
    events: game?.events?.length || 0,
    actions: game?.actionCount || 0,
    aiActions: game?.aiTraces?.length || 0,
    modelCalls: game?.metrics?.modelCalls || 0,
    streamCalls: game?.metrics?.streamCalls || 0,
    streamFallbacks: game?.metrics?.streamFallbacks || 0,
    modelRetries: game?.metrics?.modelRetries || 0,
    modelFailures: game?.metrics?.modelFailures || 0,
    invariantErrors: [...(game?.invariantErrors || [])]
  };
  if (game && game.phase !== "ended") result.invariantErrors.push(`模拟超过${maxTicks}步仍未结束`);
  simulationMode = false;
  render();
  return result;
}

async function simulateMany(count = 100, role = "random", startSeed = 1) {
  const results = [];
  for (let index = 0; index < count; index += 1) {
    results.push(await simulateGame(Number(startSeed) + index, role));
  }
  return { ...summarizeSimulationResults(results), results };
}

el("clear-settings").addEventListener("click", () => {
  try { localStorage.removeItem(MODEL_SETTINGS_KEY); } catch {}
  Object.assign(modelSettings, DEFAULT_MODEL_SETTINGS);
  fillSettingsForm();
  updateModelStatus("本地模型配置已清除");
});

el("developer-mode").checked = Boolean(appPreferences.developerMode);
fillSettingsForm();

window.__werewolfDemo = {
  getState: () => game,
  start: (role = "random", developerMode = true, seed = null) => startGame("测试玩家", role, true, developerMode, seed),
  simulate: (seed, role = "random", maxTicks = 12000) => simulateGame(seed, role, maxTicks),
  simulateMany: (count = 100, role = "random", startSeed = 1) => simulateMany(count, role, startSeed),
  pending: () => pendingHuman,
  act: (action) => submitHuman(action),
  loadReplay: (replay) => loadReplayDocument(replay),
  setDeveloperMode: (enabled) => { if (game) { game.debugMode = Boolean(enabled); render(); } },
  reset: returnToLobby
};
