const ROLES = {
  werewolf: { name: "狼人", faction: "werewolf", side: "wolf", description: "夜晚与队友选择一名目标；白天隐藏身份。" },
  villager: { name: "平民", faction: "village", side: "villager", description: "没有夜间技能，通过发言和投票找出狼人。" },
  seer: { name: "预言家", faction: "village", side: "god", description: "每晚查验一名玩家，得知其阵营。" },
  witch: { name: "女巫", faction: "village", side: "god", description: "拥有一瓶解药和一瓶毒药，同一夜只能使用一种。" }
};

const PHASES = {
  night_wolf: ["NIGHT", "狼人行动", "夜色正浓", "狼队正在选择目标"],
  night_witch: ["NIGHT", "女巫行动", "药瓶轻响", "等待女巫作出选择"],
  night_seer: ["NIGHT", "预言家查验", "微光浮现", "预言家正在查验"],
  night_resolve: ["NIGHT", "夜晚结算", "无人知晓", "命运正在落定"],
  dawn: ["DAWN", "天亮了", "晨钟响起", "公布昨夜结果"],
  discussion: ["DAY", "白天发言", "所有人睁眼", "依次陈述与判断"],
  vote: ["VOTE", "放逐投票", "票型落定", "选择你怀疑的玩家"],
  vote_retry: ["REVOTE", "平票重投", "再投一次", "只能从平票玩家中选择"],
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
  temperature: 0.7
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

function alivePlayers() {
  return game.players.filter((player) => player.alive);
}

function addEvent(kind, actor, text) {
  game.events.push({ id: game.nextEventId++, day: game.day, kind, actor, text });
  renderTimeline();
}

function setPhase(phase) {
  game.phase = phase;
  render();
}

function buildRoles(roleMode, random) {
  if (roleMode === "random") return shuffle(ROLE_POOL, random);
  const index = ROLE_POOL.indexOf(roleMode);
  const remaining = ROLE_POOL.filter((_, roleIndex) => roleIndex !== index);
  return [roleMode, ...shuffle(remaining, random)];
}

function createGame(playerName, roleMode, onlineAI, developerMode) {
  const seed = Date.now() % 2147483647;
  const random = createRng(seed);
  const roles = buildRoles(roleMode, random);
  const names = [playerName || "你", ...BOT_NAMES];
  return {
    id: `g_${seed}`,
    seed,
    random,
    day: 1,
    phase: "night_wolf",
    players: names.map((name, index) => ({
      id: `P${index + 1}`,
      seat: index,
      name,
      role: roles[index],
      alive: true,
      controller: index === 0 ? "human" : "ai",
      persona: PERSONAS[Math.max(0, index - 1)] || "沉着"
    })),
    events: [],
    privateEvents: [],
    publicClaims: [],
    aiTraces: [],
    seerKnowledge: {},
    witch: { saveAvailable: true, poisonAvailable: true },
    night: {},
    discussionIndex: 0,
    votes: {},
    voteIndex: 0,
    tieCandidates: [],
    winner: null,
    nextEventId: 1,
    nextTraceId: 1,
    onlineAI,
    debugMode: developerMode
  };
}

function startGame(playerName, roleMode, onlineAI, developerMode = appPreferences.developerMode) {
  game = createGame(playerName, roleMode, onlineAI, developerMode);
  pendingHuman = null;
  selectedTarget = null;
  lobbyScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  addEvent("night", "系统", "身份已经分配。第一夜开始，所有人闭眼。");
  updateModelStatus();
  render();
  advanceGame();
}

function updateModelStatus(message) {
  if (message) modelStatus = message;
  const configured = Boolean(modelSettings.baseUrl && modelSettings.model && modelSettings.apiKey);
  el("connection-text").textContent = modelStatus;
  el("footer-ai").textContent = game?.onlineAI
    ? configured ? `${modelSettings.dialect === "anthropic" ? "Anthropic" : "OpenAI"} 线上 AI` : "线上 AI 未配置，自动使用 Bot"
    : "AI Bot 兜底模式";
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
  game.phase = "ended";
  const copy = winner === "village" ? "所有狼人已经出局，好人阵营获胜。" : "狼人完成屠边，狼人阵营获胜。";
  addEvent("death", "系统", copy);
  pendingHuman = null;
  render();
  return true;
}

function delay(ms = 260) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function advanceGame() {
  if (!game || advancing || pendingHuman || game.phase === "ended") return;
  advancing = true;
  try {
    while (game && !pendingHuman && game.phase !== "ended") {
      render();
      if (game.phase === "night_wolf") await handleWolfNight();
      else if (game.phase === "night_witch") await handleWitchNight();
      else if (game.phase === "night_seer") await handleSeerNight();
      else if (game.phase === "night_resolve") await resolveNight();
      else if (game.phase === "dawn") await handleDawn();
      else if (game.phase === "discussion") await handleDiscussion();
      else if (game.phase === "vote" || game.phase === "vote_retry") await handleVote();
      else break;
    }
  } finally {
    advancing = false;
    render();
  }
}

async function handleWolfNight() {
  const wolves = alivePlayers().filter((player) => player.role === "werewolf");
  game.night.wolfNominations ||= {};
  const nextWolf = wolves.find((wolf) => !(wolf.id in game.night.wolfNominations));
  if (!nextWolf) {
    const nominations = Object.values(game.night.wolfNominations);
    const captain = wolves[(game.day - 1) % wolves.length];
    game.night.wolfTarget = nominations.every((target) => target === nominations[0])
      ? nominations[0]
      : game.night.wolfNominations[captain.id] || nominations[0];
    setPhase("night_witch");
    return;
  }
  const candidates = alivePlayers().filter((player) => player.role !== "werewolf").map((player) => player.id);
  if (nextWolf.controller === "human") {
    pendingHuman = { kind: "wolf", playerId: nextWolf.id, candidates };
    return;
  }
  speakingPlayerId = nextWolf.id;
  render();
  const decision = await getAIDecision(nextWolf, "wolf", candidates);
  game.night.wolfNominations[nextWolf.id] = decision.targetId;
  speakingPlayerId = null;
  await delay();
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
  if (seerId === game.players[0].id) {
    game.privateEvents.push({ day: game.day, text: `${target.name} 属于${ROLES[target.role].faction === "werewolf" ? "狼人" : "好人"}阵营。` });
  }
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
  if (deaths.length) addEvent("death", "系统", `昨夜 ${deaths.map((player) => `${player.seat + 1} 号 ${player.name}`).join("、")} 出局。`);
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
    pendingHuman = { kind: "speech", playerId: player.id };
    return;
  }
  speakingPlayerId = player.id;
  render();
  const decision = await getAIDecision(player, "speech", []);
  registerPublicClaim(decision.claim);
  addEvent("speech", player.name, decision.speech);
  speakingPlayerId = null;
  game.discussionIndex += 1;
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
  if (voteCopy) addEvent("vote", "系统", `票型：${voteCopy}`);
  if (highest === 0) {
    addEvent("vote", "系统", "没有有效票，本轮无人出局。");
    beginNextNight();
    return;
  }
  if (tied.length > 1 && game.phase === "vote") {
    game.tieCandidates = tied;
    game.votes = {};
    game.voteIndex = 0;
    addEvent("vote", "系统", `${tied.map((id) => `${playerById(id).seat + 1} 号`).join("、")} 平票，进入重投。`);
    setPhase("vote_retry");
    return;
  }
  if (tied.length !== 1) {
    addEvent("vote", "系统", "再次平票，本轮无人出局。");
    beginNextNight();
    return;
  }
  const eliminated = playerById(tied[0]);
  eliminated.alive = false;
  addEvent("death", "系统", `${eliminated.seat + 1} 号 ${eliminated.name} 被放逐出局。`);
  if (!finishIfNeeded()) beginNextNight();
}

function beginNextNight() {
  game.day += 1;
  game.night = {};
  game.votes = {};
  game.voteIndex = 0;
  game.tieCandidates = [];
  addEvent("night", "系统", `第 ${game.day} 夜开始，所有人闭眼。`);
  setPhase("night_wolf");
}

function legalTarget(targetId, candidates) {
  if (targetId === ABSTAIN) return candidates.includes(ABSTAIN);
  return candidates.includes(targetId) && Boolean(playerById(targetId)?.alive);
}

function submitHuman(action) {
  if (!pendingHuman || !game) return;
  const pending = pendingHuman;
  if (["wolf", "seer", "vote"].includes(pending.kind) && !legalTarget(action.targetId, pending.candidates)) return;
  if (pending.kind === "wolf") game.night.wolfNominations[pending.playerId] = action.targetId;
  else if (pending.kind === "seer") applySeerCheck(pending.playerId, action.targetId);
  else if (pending.kind === "witch") {
    if (action.action === "save" && !game.witch.saveAvailable) return;
    if (action.action === "poison" && (!game.witch.poisonAvailable || !legalTarget(action.targetId, pending.candidates))) return;
    game.night.witchAction = action;
  } else if (pending.kind === "speech") {
    const speech = String(action.speech || "").trim().slice(0, 180);
    if (!speech) return;
    addEvent("speech", game.players[0].name, speech);
    game.discussionIndex += 1;
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
  const context = [`你的身份是${ROLES[player.role].name}，阵营是${ROLES[player.role].faction === "werewolf" ? "狼人" : "好人"}。`];
  if (player.role === "werewolf") {
    const teammates = game.players.filter((item) => item.role === "werewolf" && item.id !== player.id).map((item) => `${item.seat + 1}号${item.name}`);
    context.push(`你的狼人队友：${teammates.join("、")}。`);
  }
  if (player.role === "seer") {
    const results = Object.entries(game.seerKnowledge[player.id] || {}).map(([id, faction]) => `${playerById(id).seat + 1}号是${faction === "werewolf" ? "狼人" : "好人"}`);
    context.push(`你的查验记录：${results.join("；") || "暂无"}。`);
  }
  if (player.role === "witch") context.push(`解药${game.witch.saveAvailable ? "可用" : "已用"}，毒药${game.witch.poisonAvailable ? "可用" : "已用"}。`);
  return context.join("\n");
}

function seerClaim(player) {
  if (player.role !== "seer") return null;
  const checks = Object.entries(game.seerKnowledge[player.id] || {}).map(([targetId, faction]) => ({ targetId, faction }));
  return { playerId: player.id, role: "seer", checks, day: game.day };
}

function formatSeerClaim(claim) {
  const checks = claim?.checks || [];
  const result = checks.map(({ targetId, faction }) => {
    const target = playerById(targetId);
    return `${target.seat + 1} 号 ${target.name}是${faction === "werewolf" ? "狼人" : "好人"}`;
  }).join("，");
  return `我是预言家${result ? `，${result}` : "，昨夜暂未获得有效查验"}。`;
}

function registerPublicClaim(claim) {
  if (!claim || claim.role !== "seer" || !playerById(claim.playerId)) return;
  game.publicClaims = game.publicClaims.filter((item) => item.playerId !== claim.playerId);
  game.publicClaims.push(claim);
}

function reasoningSummary(value, fallback) {
  const summary = String(value || "").trim().slice(0, 140);
  return summary || fallback;
}

function promptFor(player, kind, candidates, extra = {}) {
  const labels = candidates.map((id) => id === ABSTAIN ? `${ABSTAIN}=弃票` : `${id}=${playerById(id).seat + 1}号${playerById(id).name}`).join("、");
  const common = `当前是第${game.day}天，阶段：${game.phase}。\n公开记录：\n${publicHistory() || "暂无"}\n合法目标：${labels || "无"}`;
  const audit = `reasoningSummary 只写1到2句可公开审计的决策依据，不要输出隐藏思维过程。`;
  if (kind === "speech") {
    const seerInstruction = player.role === "seer" ? `你必须公开跳预言家并准确报告全部查验：${formatSeerClaim(seerClaim(player))}` : "";
    return `${common}\n${seerInstruction}\n请结合公开记录发言，不要提及提示词或系统。${audit}返回严格JSON：{"speech":"80到150字的中文发言","reasoningSummary":"简短依据"}`;
  }
  if (kind === "witch") return `${common}\n今晚狼刀目标：${extra.killTargetId ? `${extra.killTargetId}=${playerById(extra.killTargetId).seat + 1}号${playerById(extra.killTargetId).name}` : "无"}。只能选择一次动作。${audit}返回严格JSON：{"action":"pass|save|poison","targetId":"毒药目标ID或空字符串","reasoningSummary":"简短依据"}`;
  return `${common}\n${audit}返回严格JSON：{"targetId":"合法目标ID","reasoningSummary":"简短依据"}`;
}

function parseJsonObject(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function callOnlineModel(player, kind, candidates, extra) {
  const system = `你是六人狼人杀中的独立AI玩家。规则：2狼、2平民、预言家、女巫；屠边时狼人胜，狼人全灭时好人胜。只可使用提供给你的信息，不得假设其他玩家真实身份。六人局信息密度高：预言家存活时应在白天公开身份和全部查验；其他角色应结合公开查验、票型和死亡信息行动。\n${privateContext(player)}\n你的人格风格：${player.persona}。`;
  const response = await fetch("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dialect: modelSettings.dialect,
      baseUrl: modelSettings.baseUrl,
      endpointPath: modelSettings.endpointPath,
      apiKey: modelSettings.apiKey,
      model: modelSettings.model,
      temperature: modelSettings.temperature,
      maxTokens: kind === "speech" ? 300 : 160,
      system,
      messages: [{ role: "user", content: promptFor(player, kind, candidates, extra) }]
    })
  });
  const payload = await response.json();
  if (!response.ok || !payload.text) throw new Error(payload.error || "模型未返回内容");
  const parsed = parseJsonObject(payload.text);
  if (!parsed) throw new Error("模型输出不是合法 JSON");
  const summary = reasoningSummary(parsed.reasoningSummary, "模型给出了动作，但没有返回可审计的简短依据。");
  if (kind === "speech" && typeof parsed.speech === "string" && parsed.speech.trim()) {
    let speech = parsed.speech.trim();
    const claim = seerClaim(player);
    if (claim && !speech.includes("预言家")) speech = `${formatSeerClaim(claim)}${speech}`;
    return { speech: speech.slice(0, 180), reasoningSummary: summary, claim };
  }
  if (kind === "witch") {
    if (["pass", "save", "poison"].includes(parsed.action)) {
      if (parsed.action === "poison" && !legalTarget(parsed.targetId, candidates)) throw new Error("模型选择了非法毒药目标");
      return { action: parsed.action, targetId: parsed.targetId || null, reasoningSummary: summary };
    }
  }
  if (legalTarget(parsed.targetId, candidates)) return { targetId: parsed.targetId, reasoningSummary: summary };
  throw new Error("模型选择了非法目标");
}

function publicSeerClaims() {
  return game.publicClaims.filter((claim) => claim.role === "seer" && playerById(claim.playerId)?.alive);
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

function botDecision(player, kind, candidates, extra = {}) {
  const pick = (list) => list[Math.floor(game.random() * list.length)];
  if (kind === "speech") {
    if (player.role === "seer") {
      const claim = seerClaim(player);
      const wolves = claim.checks.filter((check) => check.faction === "werewolf");
      const plan = wolves.length ? `今天优先放逐 ${playerById(wolves[0].targetId).seat + 1} 号。` : "目前都是好人结果，请未验玩家重点表水。";
      return {
        speech: `${formatSeerClaim(claim)}${plan}`,
        reasoningSummary: "六人屠边局容错低，预言家应尽早公开身份和验人，让好人形成可执行的票型。",
        claim
      };
    }
    const claims = publicSeerClaims();
    const latestClaim = claims[claims.length - 1];
    const claimWolves = claimedWolfTargets(alivePlayers().map((item) => item.id));
    if (latestClaim && player.role !== "werewolf") {
      const checkedCopy = latestClaim.checks.map((check) => `${playerById(check.targetId).seat + 1}号${check.faction === "werewolf" ? "查杀" : "金水"}`).join("、");
      return {
        speech: `${playerById(latestClaim.playerId).seat + 1} 号跳预言家，报了${checkedCopy || "暂无验人"}。${claimWolves.length ? `今天先处理 ${playerById(claimWolves[0]).seat + 1} 号查杀，` : "暂时保留其预言家面，"}后续再结合对跳和票型复盘。`,
        reasoningSummary: "当前桌面已有公开预言家信息，先围绕验人建立判断，再用后续发言和票型验证可信度。"
      };
    }
    if (latestClaim && player.role === "werewolf") {
      return {
        speech: `${playerById(latestClaim.playerId).seat + 1} 号虽然跳了预言家，但单边跳不等于身份坐实。验人、发言和票型都要对得上，我暂时不盲信。`,
        reasoningSummary: "公开预言家会压缩狼队空间，因此先质疑其可信度，避免好人快速形成统一票型。"
      };
    }
    const templates = {
      werewolf: ["昨夜的信息还不够，我建议每个人明确给出怀疑对象和理由。现在过早点死狼坑，容易让真正的狼人顺势带票。", "我更关注发言里的前后矛盾。只报结论、不讲过程的位置，今天必须补充解释。"],
      witch: ["平安夜或双死都不能直接锁定身份。我会把夜间结果和白天发言分开看，重点听谁在抢着定义局势。", "目前没有公开查验，我暂时不接受无依据强推。每个人应给出明确怀疑对象，避免模糊站边。"],
      villager: ["我没有夜间信息，会从发言、站边和票型判断。今天请每个人明确给出怀疑对象，不要只重复别人的结论。", "我先表水：没有额外信息，也不急着认谁是好人。今天重点看谁在回避具体判断、强行组织票型。"]
    };
    return {
      speech: pick(templates[player.role]),
      reasoningSummary: player.role === "werewolf" ? "隐藏狼人身份并要求他人交代逻辑，借公开发言寻找可推动的放逐目标。" : "当前缺少夜间私有信息，只能要求明确站边，为之后的票型分析积累公开证据。"
    };
  }
  if (kind === "witch") {
    if (game.witch.saveAvailable && extra.killTargetId && (extra.killTargetId === player.id || game.day === 1) && game.random() > 0.28) {
      return { action: "save", reasoningSummary: extra.killTargetId === player.id ? "狼刀命中自己，使用解药可以保住关键神职。" : "第一夜信息不足，优先用解药保住存活轮次和白天信息量。" };
    }
    const publicWolves = claimedWolfTargets(candidates);
    if (game.witch.poisonAvailable && publicWolves.length) return { action: "poison", targetId: publicWolves[0], reasoningSummary: "公开预言家给出查杀，毒掉查杀目标可在夜间快速压缩狼坑。" };
    if (game.witch.poisonAvailable && game.day > 1 && candidates.length && game.random() > 0.72) return { action: "poison", targetId: pick(candidates), reasoningSummary: "对局进入后期且毒药尚未使用，主动出药避免神职死亡后浪费资源。" };
    return { action: "pass", reasoningSummary: "当前没有足够可靠的毒人依据，保留药水等待更明确的信息。" };
  }
  if (kind === "wolf") {
    const claimedSeers = publicSeerClaims().map((claim) => claim.playerId).filter((id) => candidates.includes(id));
    if (claimedSeers.length) return { targetId: claimedSeers[0], reasoningSummary: "公开跳出的预言家能持续产生查验，优先击杀可阻断好人的信息来源。" };
    return { targetId: pick(candidates), reasoningSummary: "从所有非狼队友中选择刀口；当前没有更高优先级的公开神职目标。" };
  }
  if (kind === "seer") return { targetId: pick(candidates), reasoningSummary: "优先查验尚未验证的存活玩家，扩大下一轮可公开的信息覆盖。" };
  if (kind === "vote" && candidates.includes(ABSTAIN)) {
    const validTargets = candidates.filter((id) => id !== ABSTAIN);
    if (!validTargets.length) return { targetId: ABSTAIN, reasoningSummary: "当前没有合法放逐目标，只能弃票。" };
    if (player.role === "seer") {
      const checkedWolf = Object.entries(game.seerKnowledge[player.id] || {}).find(([id, faction]) => faction === "werewolf" && validTargets.includes(id));
      if (checkedWolf) return { targetId: checkedWolf[0], reasoningSummary: "该玩家是自己的查杀结果，优先投出能直接推进好人胜利。" };
    }
    if (player.role !== "werewolf") {
      const publicWolves = claimedWolfTargets(validTargets);
      if (publicWolves.length) return { targetId: publicWolves[0], reasoningSummary: "桌面存在公开查杀，先投查杀并用翻牌结果验证预言家信息。" };
      const protectedTargets = new Set([...claimedGoodTargets(validTargets), ...publicSeerClaims().map((claim) => claim.playerId)]);
      const unresolvedTargets = validTargets.filter((id) => !protectedTargets.has(id));
      if (unresolvedTargets.length) {
        return { targetId: pick(unresolvedTargets), reasoningSummary: "当前没有公开查杀，先避开预言家及其金水，从尚未验证的位置中投票。" };
      }
    } else {
      const seerTargets = publicSeerClaims().map((claim) => claim.playerId).filter((id) => validTargets.includes(id));
      if (seerTargets.length) return { targetId: seerTargets[0], reasoningSummary: "投票压制公开预言家，减少狼队友被查杀和组织归票的风险。" };
    }
    if (game.random() < 0.06) return { targetId: ABSTAIN, reasoningSummary: "当前没有形成可靠信息链，选择弃票避免把随机票变成错误放逐。" };
    candidates = validTargets;
  }
  let pool = [...candidates];
  if (player.role === "werewolf") {
    const nonWolves = pool.filter((id) => playerById(id).role !== "werewolf");
    if (nonWolves.length) pool = nonWolves;
  }
  return { targetId: pick(pool), reasoningSummary: "没有强查验或明确公开信息，依据当前合法目标做低置信度选择。" };
}

function describeDecision(kind, decision) {
  if (kind === "speech") return `发言：${decision.speech}`;
  if (kind === "witch") {
    if (decision.action === "save") return "女巫使用解药";
    if (decision.action === "poison") return `女巫毒杀 ${playerById(decision.targetId).seat + 1} 号 ${playerById(decision.targetId).name}`;
    return "女巫不使用药水";
  }
  const target = decision.targetId === ABSTAIN ? null : playerById(decision.targetId);
  if (kind === "vote" && decision.targetId === ABSTAIN) return "投票：弃票";
  const labels = { wolf: "狼刀", seer: "查验", vote: "投票" };
  return `${labels[kind] || kind}：${target ? `${target.seat + 1} 号 ${target.name}` : "无目标"}`;
}

function recordAITrace(player, kind, decision, source) {
  game.aiTraces.push({
    id: game.nextTraceId++,
    day: game.day,
    phase: game.phase,
    playerId: player.id,
    role: player.role,
    kind,
    source,
    action: describeDecision(kind, decision),
    reasoningSummary: reasoningSummary(decision.reasoningSummary, "未提供决策依据。")
  });
  if (game.aiTraces.length > 80) game.aiTraces.shift();
}

async function getAIDecision(player, kind, candidates, extra = {}) {
  const onlineConfigured = Boolean(game.onlineAI && modelSettings.baseUrl && modelSettings.model && modelSettings.apiKey);
  if (onlineConfigured) {
    try {
      updateModelStatus(`线上 AI · ${player.name} 思考中`);
      const decision = await callOnlineModel(player, kind, candidates, extra);
      recordAITrace(player, kind, decision, "线上模型");
      updateModelStatus("线上 AI 已连接");
      return decision;
    } catch (error) {
      updateModelStatus("线上 AI 失败，已回退 Bot");
      console.warn("Online AI fallback:", error);
    }
  }
  const decision = botDecision(player, kind, candidates, extra);
  recordAITrace(player, kind, decision, game.onlineAI ? (onlineConfigured ? "Bot 回退" : "本地 Bot（模型未配置）") : "本地 Bot");
  return decision;
}

function roleDescription(player) {
  if (game.phase === "ended") return `${ROLES[player.role].name} · ${ROLES[player.role].faction === "werewolf" ? "狼人阵营" : "好人阵营"}`;
  if (game.debugMode) return `${ROLES[player.role].name} · 开发视图`;
  const human = game.players[0];
  if (human.role === "werewolf" && player.role === "werewolf" && player.id !== human.id) return "狼队友";
  if (player.controller === "human") return ROLES[player.role].name;
  return player.alive ? "身份未知" : "身份未公开";
}

function renderTable() {
  tableStage.querySelectorAll(".seat").forEach((node) => node.remove());
  const human = game.players[0];
  for (const player of game.players) {
    const isWolfTeammate = human.role === "werewolf" && player.role === "werewolf" && player.id !== human.id;
    const node = document.createElement("button");
    node.type = "button";
    node.className = `seat${player.controller === "human" ? " is-you" : ""}${isWolfTeammate ? " is-teammate" : ""}${player.alive ? "" : " is-dead"}${speakingPlayerId === player.id ? " is-speaking" : ""}${pendingHuman?.candidates?.includes(player.id) ? " seat-selectable" : ""}`;
    node.dataset.seat = String(player.seat);
    node.disabled = !pendingHuman?.candidates?.includes(player.id);
    node.innerHTML = `<span class="seat-avatar">${player.seat + 1}</span><span class="seat-info"><span class="seat-name">${escapeHtml(player.name)}</span><span class="seat-meta">${escapeHtml(roleDescription(player))}</span></span><span class="seat-state">${player.alive ? "存活" : "出局"}</span>`;
    if (pendingHuman?.candidates?.includes(player.id)) node.addEventListener("click", () => { selectedTarget = player.id; renderActionPanel(); renderTable(); });
    if (selectedTarget === player.id) node.classList.add("selected");
    tableStage.appendChild(node);
  }
}

function renderTimeline() {
  if (!game) return;
  if (!game.events.length) {
    timeline.innerHTML = '<div class="empty-log">桌面还没有公开事件</div>';
    return;
  }
  timeline.innerHTML = game.events.slice(-50).map((event) => `<article class="event event-${escapeHtml(event.kind)}"><div class="event-meta"><strong>${escapeHtml(event.actor)}</strong><span>第 ${event.day} 天</span></div><div class="event-copy">${event.kind === "speech" ? '<span class="quote">“</span>' : ""}${escapeHtml(event.text)}${event.kind === "speech" ? '<span class="quote">”</span>' : ""}</div></article>`).join("");
  requestAnimationFrame(() => { timeline.scrollTop = timeline.scrollHeight; });
}

function renderRoleCard() {
  const human = game.players[0];
  const privateNotes = [];
  if (human.role === "werewolf") {
    const teammate = game.players.find((player) => player.role === "werewolf" && player.id !== human.id);
    privateNotes.push(`队友：${teammate.seat + 1} 号 ${teammate.name}`);
  }
  if (human.role === "seer") privateNotes.push(...game.privateEvents.slice(-2).map((event) => event.text));
  if (human.role === "witch") privateNotes.push(`解药：${game.witch.saveAvailable ? "可用" : "已用"} · 毒药：${game.witch.poisonAvailable ? "可用" : "已用"}`);
  roleCard.innerHTML = `<span class="role-label">PRIVATE ROLE</span><div class="role-name">${escapeHtml(ROLES[human.role].name)}</div><p class="role-desc">${escapeHtml(ROLES[human.role].description)}${privateNotes.length ? `<br>${privateNotes.map(escapeHtml).join("<br>")}` : ""}</p>`;
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
    return `<article class="debug-trace"><div class="trace-meta"><strong>${player.seat + 1}号 ${escapeHtml(player.name)}</strong>${escapeHtml(ROLES[trace.role].name)} · 第${trace.day}天<br>${escapeHtml(trace.source)}</div><div class="trace-action"><div>${escapeHtml(trace.action)}</div><div class="trace-reason">依据：${escapeHtml(trace.reasoningSummary)}</div></div></article>`;
  }).join("") : '<div class="debug-empty">AI 尚未产生决策记录。</div>';
}

function targetButtons(candidates) {
  return `<div class="target-list">${candidates.map((id) => { if (id === ABSTAIN) return `<button type="button" class="target-button abstain-button${selectedTarget === id ? " selected" : ""}" data-target="${id}"><span>弃票</span><small>不投给任何玩家</small></button>`; const player = playerById(id); return `<button type="button" class="target-button${selectedTarget === id ? " selected" : ""}" data-target="${id}"><span>${player.seat + 1} 号 · ${escapeHtml(player.name)}</span><small>${player.alive ? "存活" : "出局"}</small></button>`; }).join("")}</div>`;
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
  if (game.phase === "ended") {
    const winner = game.winner === "village" ? "好人阵营获胜" : "狼人阵营获胜";
    actionContent.innerHTML = `<div class="result-box"><strong>${winner}</strong><p>完整身份已经在桌面座位上揭示。可以复盘公开记录，或重新开一局测试其他身份。</p></div><button type="button" class="primary-button action-submit" id="restart-action">重新开局 <span>→</span></button>`;
    el("restart-action").addEventListener("click", returnToLobby);
    return;
  }
  if (!pendingHuman) {
    const thinking = speakingPlayerId ? `${playerById(speakingPlayerId).name} 正在行动` : "规则引擎正在推进阶段";
    actionContent.innerHTML = `<p class="action-kicker">WAITING</p><h3 class="action-title">等待桌面行动</h3><p class="action-help">AI 会依次完成发言、技能或投票。轮到你时，操作会自动出现在这里。</p><div class="ai-thinking">${escapeHtml(thinking)}</div>`;
    return;
  }
  if (pendingHuman.kind === "speech") {
    actionContent.innerHTML = `<form class="speech-form" id="speech-form"><p class="action-kicker">YOUR TURN</p><h3 class="action-title">轮到你发言</h3><p class="action-help">发言会成为公开记录。可以质疑、报身份或给出你的狼坑。</p><textarea id="speech-input" maxlength="180" placeholder="输入你的发言…" required></textarea><button class="primary-button action-submit" type="submit">提交发言 <span>→</span></button></form>`;
    el("speech-form").addEventListener("submit", (event) => { event.preventDefault(); submitHuman({ speech: el("speech-input").value }); });
    return;
  }
  if (pendingHuman.kind === "witch") {
    const killed = playerById(pendingHuman.killTargetId);
    actionContent.innerHTML = `<p class="action-kicker">WITCH ACTION</p><h3 class="action-title">选择一种行动</h3><p class="action-help">今晚狼刀指向 ${killed ? `${killed.seat + 1} 号 ${escapeHtml(killed.name)}` : "无人"}。同一夜只能使用一瓶药。</p>${game.witch.poisonAvailable ? targetButtons(pendingHuman.candidates) : ""}<div class="target-list action-submit">${game.witch.saveAvailable && killed ? '<button type="button" class="target-button" id="witch-save"><span>使用解药</span><small>救下狼刀目标</small></button>' : ""}${game.witch.poisonAvailable ? '<button type="button" class="target-button" id="witch-poison"><span>使用毒药</span><small>需先选择目标</small></button>' : ""}<button type="button" class="target-button" id="witch-pass"><span>不用药</span><small>保留药水</small></button></div>`;
    bindTargetButtons();
    el("witch-save")?.addEventListener("click", () => submitHuman({ action: "save" }));
    el("witch-poison")?.addEventListener("click", () => { if (selectedTarget) submitHuman({ action: "poison", targetId: selectedTarget }); });
    el("witch-pass").addEventListener("click", () => submitHuman({ action: "pass" }));
    return;
  }
  const labels = { wolf: ["WOLF ACTION", "选择刀口", "与你的队友共同决定今晚的目标。"], seer: ["SEER CHECK", "选择查验目标", "查验结果只对你可见。"], vote: ["YOUR VOTE", game.phase === "vote_retry" ? "平票重投" : "选择放逐目标", "不能投自己；可以弃票，票型会在所有人完成后公开。"] };
  const [kicker, title, help] = labels[pendingHuman.kind];
  actionContent.innerHTML = `<p class="action-kicker">${kicker}</p><h3 class="action-title">${title}</h3><p class="action-help">${help}</p>${targetButtons(pendingHuman.candidates)}<button class="primary-button action-submit" id="submit-target" type="button" ${selectedTarget ? "" : "disabled"}>确认选择 <span>→</span></button>`;
  bindTargetButtons();
  el("submit-target").addEventListener("click", () => { if (selectedTarget) submitHuman({ targetId: selectedTarget }); });
}

function render() {
  updateModelStatus();
  if (!game) return;
  const phase = PHASES[game.phase];
  el("phase-eyebrow").textContent = `${phase[0]} ${String(game.day).padStart(2, "0")}`;
  el("phase-title").textContent = phase[1];
  el("table-core-title").textContent = phase[2];
  el("table-core-subtitle").textContent = phase[3];
  el("round-badge").textContent = `${game.phase.startsWith("night") ? "第" : "第"} ${game.day} ${game.phase.startsWith("night") ? "夜" : "天"}`;
  el("alive-count").textContent = `${alivePlayers().length}/6`;
  renderTable();
  renderTimeline();
  renderRoleCard();
  renderActionPanel();
  renderDeveloperPanel();
}

function returnToLobby() {
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
  startGame(el("player-name").value.trim(), el("role-mode").value, el("online-ai").checked, appPreferences.developerMode);
});
el("new-game").addEventListener("click", returnToLobby);
el("toggle-developer").addEventListener("click", () => {
  if (!game) return;
  game.debugMode = !game.debugMode;
  appPreferences.developerMode = game.debugMode;
  el("developer-mode").checked = game.debugMode;
  saveStoredObject(APP_PREFERENCES_KEY, appPreferences);
  render();
});
el("open-settings").addEventListener("click", () => settingsDialog.showModal());
el("temperature").addEventListener("input", () => { el("temperature-output").textContent = el("temperature").value; });
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
  el("temperature").value = String(modelSettings.temperature);
  el("temperature-output").textContent = String(modelSettings.temperature);
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
  start: (role = "random", developerMode = true) => startGame("测试玩家", role, false, developerMode),
  pending: () => pendingHuman,
  act: (action) => submitHuman(action),
  setDeveloperMode: (enabled) => { if (game) { game.debugMode = Boolean(enabled); render(); } },
  reset: returnToLobby
};
