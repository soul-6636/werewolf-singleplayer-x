import { addDeception, createDeceptionLedger, reconcileDeception, snapshotDeceptionLedger, updateDeceptionStatus } from "./ai-deception.js";

export const CLAIM_TYPES = Object.freeze({
  ROLE_CLAIM: "ROLE_CLAIM",
  SEER_RESULT_CLAIM: "SEER_RESULT_CLAIM",
  IDENTITY_HYPOTHESIS: "IDENTITY_HYPOTHESIS",
  VOTE_INTENT: "VOTE_INTENT",
  TRUST_DECLARATION: "TRUST_DECLARATION",
  ATTACK: "ATTACK",
  PROTECT: "PROTECT"
});

export const COMMUNICATION_INTENTS = Object.freeze([
  "inform",
  "declare",
  "probe",
  "persuade",
  "defend",
  "redirect",
  "bait",
  "distance",
  "concede"
]);

export const DISCLOSURE_MODES = Object.freeze([
  "reveal_now",
  "partial_reveal",
  "withhold",
  "delay_until_pressured",
  "bluff"
]);

export const PRESSURE_LEVELS = Object.freeze([
  "low",
  "medium",
  "high",
  "sacrifice"
]);

const MAX_PUBLIC_EVENTS = 80;
const MAX_PRIVATE_EVENTS = 40;
const MAX_EVIDENCE = 12;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function initialRoleHypotheses() {
  return { werewolf: 0.33, villager: 0.34, seer: 0.17, witch: 0.16 };
}

function createBelief(player) {
  return {
    seat: player.seat,
    suspicion: 20,
    roleHypotheses: initialRoleHypotheses(),
    evidence: [],
    lastUpdatedEventId: 0
  };
}

export function createAgentMemory({ gameId, player, players }) {
  return {
    version: 1,
    gameId,
    playerId: player.id,
    playerSeat: player.seat,
    publicEvents: [],
    privateEvents: [],
    claims: [],
    beliefs: Object.fromEntries(players.map((item) => [item.id, createBelief(item)])),
    wolfCandidateSets: [],
    secondOrderBeliefs: [],
    perspectiveAnalyses: [],
    informationBoundaryNotes: [],
    motiveAnalyses: [],
    communicationLog: [],
    disclosurePlan: null,
    activeDeceptions: [],
    deceptionLedger: createDeceptionLedger(),
    roundSummaries: [],
    lastReasoningSummary: "",
    updatedAtEventId: 0
  };
}

export function createClaimGraph() {
  return { version: 1, nextId: 1, nodes: [], edges: [] };
}

export function appendPublicEvent(memory, event) {
  if (!memory || memory.publicEvents.some((item) => item.id === event.id)) return;
  memory.publicEvents.push({ ...event });
  if (memory.publicEvents.length > MAX_PUBLIC_EVENTS) memory.publicEvents.shift();
  memory.updatedAtEventId = Math.max(memory.updatedAtEventId, Number(event.id) || 0);
}

export function appendPrivateEvent(memory, event) {
  if (!memory || memory.privateEvents.some((item) => item.id === event.id)) return;
  memory.privateEvents.push({ ...event });
  if (memory.privateEvents.length > MAX_PRIVATE_EVENTS) memory.privateEvents.shift();
  memory.updatedAtEventId = Math.max(memory.updatedAtEventId, Number(event.id) || 0);
}

export function addBeliefEvidence(memory, playerId, evidence) {
  const belief = memory?.beliefs?.[playerId];
  if (!belief) return;
  const delta = clamp(evidence.delta, -25, 25);
  belief.suspicion = clamp(belief.suspicion + delta, 0, 100);
  belief.evidence = [{
    eventId: evidence.eventId || 0,
    summary: String(evidence.summary || "").slice(0, 180),
    delta,
    alternatives: Array.isArray(evidence.alternatives) ? evidence.alternatives.slice(0, 3) : []
  }, ...belief.evidence].slice(0, MAX_EVIDENCE);
  belief.lastUpdatedEventId = Math.max(belief.lastUpdatedEventId, Number(evidence.eventId) || 0);
}

export function addClaimNode(graph, claim) {
  if (!graph || !claim?.speakerId || !claim.type) return null;
  const duplicate = graph.nodes.find((node) =>
    node.speakerId === claim.speakerId &&
    node.type === claim.type &&
    node.targetId === claim.targetId &&
    node.claimedValue === claim.claimedValue &&
    node.sourceEventId === claim.sourceEventId
  );
  if (duplicate) return duplicate;

  const conflicts = graph.nodes.filter((node) =>
    node.status === "ACTIVE" &&
    node.speakerId === claim.speakerId &&
    node.type === claim.type &&
    node.targetId === claim.targetId &&
    node.claimedValue !== claim.claimedValue
  );
  for (const node of conflicts) node.status = "CONTRADICTED";

  const node = {
    id: `claim_${graph.nextId++}`,
    day: claim.day,
    speakerId: claim.speakerId,
    speakerSeat: claim.speakerSeat || null,
    type: claim.type,
    targetId: claim.targetId || null,
    targetSeat: claim.targetSeat || null,
    claimedValue: String(claim.claimedValue || "").slice(0, 120),
    sourceEventId: claim.sourceEventId || null,
    status: "ACTIVE"
  };
  graph.nodes.push(node);
  return node;
}

export function addClaimToMemory(memory, claim) {
  if (!memory || !claim) return;
  if (memory.claims.some((item) => item.id === claim.id)) return;
  memory.claims.push({ ...claim });
  if (memory.claims.length > 80) memory.claims.shift();
  if (claim.type === CLAIM_TYPES.SEER_RESULT_CLAIM && claim.targetId) {
    addBeliefEvidence(memory, claim.targetId, {
      eventId: claim.sourceEventId,
      delta: claim.claimedValue === "werewolf" ? 22 : -8,
      summary: `${claim.speakerSeat}号公开报告${claim.targetSeat}号为${claim.claimedValue === "werewolf" ? "狼人" : "好人"}。`,
      alternatives: ["声明可能为虚假身份或错误解读，需要结合后续票型验证。"]
    });
  }
  recordClaimAnalysis(memory, claim);
  refreshWolfCandidateSets(memory);
}

function pushLimited(list, item, limit) {
  list.unshift(item);
  if (list.length > limit) list.pop();
}

export function recordClaimAnalysis(memory, claim) {
  if (!memory || !claim) return;
  const target = claim.targetSeat ? `${claim.targetSeat}号` : "该声明";
  const value = claim.claimedValue === "werewolf" ? "狼人" : claim.claimedValue === "village" ? "好人" : claim.claimedValue;
  const alternatives = claim.type === CLAIM_TYPES.SEER_RESULT_CLAIM
    ? ["真实查验结果", "狼人悍跳或虚构查验", "公开表达或记忆出现错误"]
    : ["真实身份声明", "为影响票型而进行的伪装", "在压力下的临时说法"];
  pushLimited(memory.informationBoundaryNotes, {
    sourceEventId: claim.sourceEventId,
    subjectSeat: claim.speakerSeat,
    summary: `${claim.speakerSeat}号公开声明${target}为${value}，不能直接升级为规则真值。`,
    alternatives
  }, 12);
  pushLimited(memory.motiveAnalyses, {
    sourceEventId: claim.sourceEventId,
    actorSeat: claim.speakerSeat,
    pushedTargetSeat: claim.type === CLAIM_TYPES.SEER_RESULT_CLAIM && claim.claimedValue === "werewolf" ? claim.targetSeat : null,
    protectedTargetSeat: claim.type === CLAIM_TYPES.SEER_RESULT_CLAIM && claim.claimedValue !== "werewolf" ? claim.targetSeat : null,
    likelyBeneficiaries: claim.targetSeat ? [claim.targetSeat] : [],
    supporting: ["公开声明会改变目标的可信度和票型压力。"],
    opposing: ["声明可能是好人推理、狼队伪装或表达失误，需结合后续票型验证。"]
  }, 12);
  if (claim.type === CLAIM_TYPES.SEER_RESULT_CLAIM && claim.targetId) {
    const perspective = {
      depth: 1,
      subjectSeat: claim.speakerSeat,
      objectSeat: claim.targetSeat,
      hypothesis: `${claim.speakerSeat}号可能把${claim.targetSeat}号判断为${value}，并据此推动后续票型。`,
      evidenceEventIds: [claim.sourceEventId],
      alternatives,
      expiresAfterDay: (Number(claim.day) || 0) + 1
    };
    pushLimited(memory.secondOrderBeliefs, perspective, 8);
    pushLimited(memory.perspectiveAnalyses, {
      ...perspective,
      basis: "仅使用公开身份声明、查验措辞和可见行为，不读取其他角色记忆。"
    }, 8);
  }
}

export function expireSecondOrderBeliefs(memory, currentDay) {
  if (!memory) return;
  memory.secondOrderBeliefs = memory.secondOrderBeliefs.filter((item) => (item.expiresAfterDay || 0) >= currentDay);
  memory.perspectiveAnalyses = memory.perspectiveAnalyses.filter((item) => (item.expiresAfterDay || 0) >= currentDay);
}

export function recordCommunication(memory, communication) {
  if (!memory || !communication) return;
  pushLimited(memory.communicationLog, {
    sourceEventId: communication.sourceEventId || null,
    day: communication.day,
    intent: COMMUNICATION_INTENTS.includes(communication.intent) ? communication.intent : "inform",
    disclosureMode: DISCLOSURE_MODES.includes(communication.disclosureMode) ? communication.disclosureMode : "withhold",
    pressureLevel: PRESSURE_LEVELS.includes(communication.pressureLevel) ? communication.pressureLevel : "low",
    targetIds: Array.isArray(communication.targetIds) ? communication.targetIds.slice(0, 3) : [],
    expectedReaction: String(communication.expectedReaction || "").slice(0, 120),
    text: String(communication.text || "").slice(0, 180)
  }, 20);
}

export function recordDeception(memory, deception) {
  if (!memory || !deception) return null;
  memory.deceptionLedger ||= createDeceptionLedger();
  const entry = addDeception(memory.deceptionLedger, deception);
  memory.activeDeceptions = memory.deceptionLedger.entries
    .filter((item) => item.status === "ACTIVE")
    .map((item) => ({ ...item }));
  return entry;
}

export function reconcileMemoryDeceptions(memory, observation) {
  if (!memory) return [];
  memory.deceptionLedger ||= createDeceptionLedger();
  const conflicts = reconcileDeception(memory.deceptionLedger, observation);
  memory.activeDeceptions = memory.deceptionLedger.entries
    .filter((item) => item.status === "ACTIVE")
    .map((item) => ({ ...item }));
  return conflicts;
}

export function updateMemoryDeceptionStatus(memory, entryId, status, note) {
  if (!memory) return null;
  memory.deceptionLedger ||= createDeceptionLedger();
  const entry = updateDeceptionStatus(memory.deceptionLedger, entryId, status, note);
  memory.activeDeceptions = memory.deceptionLedger.entries
    .filter((item) => item.status === "ACTIVE")
    .map((item) => ({ ...item }));
  return entry;
}

export function refreshWolfCandidateSets(memory) {
  const ranked = Object.entries(memory?.beliefs || {})
    .filter(([playerId]) => playerId !== memory?.playerId)
    .sort(([, left], [, right]) => right.suspicion - left.suspicion)
    .slice(0, 3)
    .map(([playerId]) => playerId);
  memory.wolfCandidateSets = ranked.length >= 2 ? [ranked] : [];
}

export function setReasoningSummary(memory, summary) {
  if (memory) memory.lastReasoningSummary = String(summary || "").slice(0, 180);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizePublicSpeech(text, players = []) {
  let normalized = String(text || "").trim();
  const replacements = players
    .map((player) => ({
      name: String(player.name || "").trim(),
      seat: Number(player.seat) + 1
    }))
    .filter(({ name }) => name && (name.length >= 2 || !["你", "我", "他", "她", "它"].includes(name)))
    .sort((left, right) => right.name.length - left.name.length);
  for (const { name, seat } of replacements) {
    normalized = normalized.replace(new RegExp(escapeRegExp(name), "g"), `${seat}号`);
  }
  normalized = normalized.replace(/\bP[1-6]\b/gi, (id) => `${Number(id.slice(1))}号`);
  return normalized;
}

export function validatePublicSpeech(text, players = [], maxChars = 180) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, reason: "公开发言不能为空" };
  if (raw.length > maxChars) return { ok: false, reason: `公开发言不能超过${maxChars}字` };
  const normalized = sanitizePublicSpeech(raw, players);
  const forbidden = [
    "脚步声",
    "狗叫",
    "呼吸声",
    "敲桌",
    "音量",
    "语速",
    "闻到",
    "听到夜里",
    "看见夜里"
  ];
  const forbiddenWord = forbidden.find((word) => normalized.includes(word));
  if (forbiddenWord) return { ok: false, reason: `发言包含未经引擎确认的观测：${forbiddenWord}` };
  if (/\bP[1-6]\b/i.test(normalized)) return { ok: false, reason: "公开发言不能包含内部玩家 ID" };
  return { ok: true, text: normalized, changed: normalized !== raw };
}

export function validateGameState(state) {
  const errors = [];
  if (!state || !Array.isArray(state.players)) return ["游戏状态缺少玩家列表"];
  const players = state.players;
  if (players.length !== 6) errors.push(`玩家数量应为6，实际为${players.length}`);
  const seats = players.map((player) => player.seat).sort((left, right) => left - right);
  if (seats.join(",") !== "0,1,2,3,4,5") errors.push("座位必须严格为1至6号且不重复");
  const roles = players.map((player) => player.role);
  for (const [role, expected] of [["werewolf", 2], ["villager", 2], ["seer", 1], ["witch", 1]]) {
    if (roles.filter((value) => value === role).length !== expected) errors.push(`${role}数量不符合规则`);
  }
  const eventIds = (state.events || []).map((event) => event.id);
  for (let index = 1; index < eventIds.length; index += 1) {
    if (eventIds[index] <= eventIds[index - 1]) errors.push("公开事件 sequence 不单调递增");
  }
  const namePlayers = players.filter((player) => player.name && player.name !== "你");
  for (const event of state.events || []) {
    if (event.kind !== "speech") continue;
    const check = validatePublicSpeech(event.text, players);
    if (!check.ok) errors.push(`公开发言不合法：${check.reason}`);
    if (check.changed) errors.push("公开发言包含姓名或内部 ID");
    if (namePlayers.some((player) => String(event.text).includes(player.name))) errors.push("公开事件包含玩家姓名");
    if (/\bP[1-6]\b/i.test(String(event.text))) errors.push("公开事件包含内部 PlayerId");
  }
  const seenDead = new Set();
  for (const event of state.events || []) {
    if (event.kind !== "death") continue;
    if (!/(出局|自爆)/.test(String(event.text))) continue;
    for (const match of String(event.text).matchAll(/([1-6])\s*号/g)) seenDead.add(Number(match[1]));
  }
  for (const player of players) {
    const pendingNightDeath = (state.night?.deaths || []).includes(player.id);
    if (!player.alive && !seenDead.has(player.seat + 1) && !pendingNightDeath && !["night_resolve", "dawn"].includes(state.phase)) {
      const deathEvents = (state.events || []).filter((event) => event.kind === "death");
      const recentDeath = deathEvents.slice(-1)[0];
      errors.push(`${player.seat + 1}号已死亡但没有对应公开死亡事件（阶段${state.phase}，夜间待处理${(state.night?.deaths || []).join(",") || "无"}，已识别座位${[...seenDead].join(",") || "无"}，死亡记录${deathEvents.map((event) => event.text).join("|") || "无"}）`);
    }
  }
  for (const memory of Object.values(state.agentMemories || {})) {
    const owner = players.find((player) => player.id === memory.playerId);
    if (!owner) {
      errors.push("AgentMemory 所属玩家不存在");
      continue;
    }
    if (memory.gameId !== state.id) errors.push(`${owner.seat + 1}号 AgentMemory 跨局`);
    for (const event of memory.privateEvents || []) {
      if (event.kind === "wolf-room" && owner.role !== "werewolf") errors.push("非狼人读取狼队频道");
      if (event.kind === "seer-check" && owner.role !== "seer") errors.push("非预言家读取查验");
      if (event.kind === "witch-night" && owner.role !== "witch") errors.push("非女巫读取狼刀或药水");
    }
  }
  if (state.phase === "ended" && state.ended !== true) errors.push("结束阶段缺少 ended 标记");
  if (state.ended === true && state.phase !== "ended") errors.push("结束状态迁移到了非结束阶段");
  return [...new Set(errors)];
}

function privateEventVisibleToRole(event, role) {
  if (event.kind === "wolf-room") return role === "werewolf";
  if (event.kind === "seer-check") return role === "seer";
  if (event.kind === "witch-night") return role === "witch";
  return true;
}

export function buildAgentContext({
  gameId,
  day,
  phase,
  self,
  memory,
  aliveSeats = [],
  publicRounds = [],
  currentRoundEvents = [],
  voteHistory = [],
  teammates = [],
  wolfRoom = null,
  seerResults = [],
  witchState = null,
  legalActions = [],
  persona = "",
  promptVersion = "v1"
}) {
  const privateEvents = (memory?.privateEvents || [])
    .filter((event) => privateEventVisibleToRole(event, self.role))
    .slice(-12)
    .map((event) => ({ kind: event.kind, day: event.day, text: event.text }));
  const context = {
    game: {
      gameId,
      day,
      phase,
      selfSeat: self.seat,
      aliveSeats: [...aliveSeats],
      publicRounds: [...publicRounds],
      currentRoundEvents: [...currentRoundEvents],
      voteHistory: [...voteHistory]
    },
    self: {
      id: self.id,
      seat: self.seat,
      role: self.role,
      faction: self.faction,
      privateEvents
    },
    memory: {
      claims: [...(memory?.claims || [])],
      beliefs: { ...(memory?.beliefs || {}) },
      wolfCandidateSets: [...(memory?.wolfCandidateSets || [])],
      perspectiveAnalyses: [...(memory?.perspectiveAnalyses || [])],
      secondOrderBeliefs: [...(memory?.secondOrderBeliefs || [])],
      disclosurePlan: memory?.disclosurePlan || null,
      activeDeceptions: [...(memory?.activeDeceptions || [])],
      roundSummaries: [...(memory?.roundSummaries || [])],
      lastReasoningSummary: memory?.lastReasoningSummary || ""
    },
    legalActions: [...legalActions],
    persona,
    promptVersion
  };
  if (self.role === "werewolf") {
    context.wolfRoom = {
      teammates: [...teammates],
      messages: [...(wolfRoom?.messages || [])],
      proposals: [...(wolfRoom?.proposals || [])],
      plan: wolfRoom?.plan || null
    };
  }
  if (self.role === "seer") context.roleFacts = { seerResults: [...seerResults] };
  if (self.role === "witch") context.roleFacts = { witchState: witchState ? { ...witchState } : null };
  return context;
}

export function memoryPrompt(memory, seatLabel) {
  if (!memory) return "暂无独立认知记录。";
  const ranked = Object.entries(memory.beliefs || {})
    .filter(([playerId]) => playerId !== memory.playerId)
    .sort(([, left], [, right]) => right.suspicion - left.suspicion)
    .slice(0, 3)
    .map(([playerId, belief]) => `${seatLabel(playerId)}怀疑度${Math.round(belief.suspicion)}`);
  const claims = (memory.claims || []).slice(-8).map((claim) => {
    const target = claim.targetId ? `，目标${seatLabel(claim.targetId)}` : "";
    return `${claim.speakerSeat}号${claim.type}${target}=${claim.claimedValue}[${claim.status}]`;
  });
  const summaries = (memory.roundSummaries || []).slice(-3).map((item) => item.text);
  const secondOrder = (memory.secondOrderBeliefs || []).slice(-3).map((item) => item.hypothesis);
  const motives = (memory.motiveAnalyses || []).slice(-3).map((item) => {
    const pushed = item.pushedTargetSeat ? `推动${item.pushedTargetSeat}号` : "未明确推动目标";
    return `${item.actorSeat}号${pushed}`;
  });
  return [
    `你的独立认知：${ranked.join("、") || "暂无足够证据"}。`,
    `可追溯声明：${claims.join("；") || "暂无"}。`,
    `有限二阶假设：${secondOrder.join("；") || "暂无"}。`,
    `动机与受益分析：${motives.join("；") || "暂无"}。`,
    `上一轮推理摘要：${memory.lastReasoningSummary || "暂无"}。`,
    `轮次摘要：${summaries.join("；") || "暂无"}。`
  ].join("\n");
}

export function validateReplayDocument(replay) {
  const errors = [];
  if (!replay || typeof replay !== "object") return ["回放文件不是对象"];
  if (replay.version !== 1) errors.push("不支持的回放版本");
  if (!replay.gameId) errors.push("回放缺少 gameId");
  if (!Array.isArray(replay.players)) {
    errors.push("回放缺少玩家列表");
    return errors;
  }
  if (replay.players.length !== 6) errors.push(`回放玩家数量应为6，实际为${replay.players.length}`);
  const seats = replay.players.map((player) => player.seat).sort((left, right) => left - right);
  if (seats.join(",") !== "0,1,2,3,4,5") errors.push("回放座位必须严格为1至6号且不重复");
  for (const [role, expected] of [["werewolf", 2], ["villager", 2], ["seer", 1], ["witch", 1]]) {
    if (replay.players.filter((player) => player.role === role).length !== expected) errors.push(`回放${role}数量不符合规则`);
  }
  if (!Array.isArray(replay.events)) {
    errors.push("回放缺少公开事件");
  } else {
    let previousId = 0;
    const seenDeadSeats = new Set();
    for (const event of replay.events) {
      if (!Number.isInteger(event.id) || event.id <= previousId) errors.push("回放公开事件 sequence 不单调递增");
      previousId = Number(event.id) || previousId;
      if (event.kind === "death") {
        for (const match of String(event.text || "").matchAll(/([1-6])\s*号/g)) seenDeadSeats.add(Number(match[1]));
      }
      if (event.kind !== "speech") continue;
      const check = validatePublicSpeech(event.text, replay.players);
      if (!check.ok || check.changed) errors.push("回放公开发言包含非法信息");
    }
    for (const player of replay.players) {
      if (!player.alive && !seenDeadSeats.has(Number(player.seat) + 1)) errors.push(`回放缺少${Number(player.seat) + 1}号死亡事件`);
    }
  }
  return [...new Set(errors)];
}

export function summarizeSimulationResults(results = []) {
  const list = Array.isArray(results) ? results : [];
  const average = (key) => {
    const values = list.map((item) => Number(item?.[key]) || 0);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  };
  const winners = list.reduce((counts, item) => {
    const key = item?.winner || "unfinished";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  return {
    count: list.length,
    completed: list.filter((item) => item?.phase === "ended").length,
    failures: list.filter((item) => item?.invariantErrors?.length || item?.phase !== "ended"),
    winners,
    averageDays: average("day"),
    averageActions: average("actions"),
    averageAiActions: average("aiActions"),
    modelCalls: list.reduce((sum, item) => sum + (Number(item?.modelCalls) || 0), 0),
    streamCalls: list.reduce((sum, item) => sum + (Number(item?.streamCalls) || 0), 0),
    streamFallbacks: list.reduce((sum, item) => sum + (Number(item?.streamFallbacks) || 0), 0),
    modelRetries: list.reduce((sum, item) => sum + (Number(item?.modelRetries) || 0), 0),
    fallbacks: list.reduce((sum, item) => sum + (Number(item?.fallbacks) || 0), 0)
  };
}

export function snapshotMemory(memory) {
  const snapshot = JSON.parse(JSON.stringify(memory));
  if (memory?.deceptionLedger) snapshot.deceptionLedger = snapshotDeceptionLedger(memory.deceptionLedger);
  return snapshot;
}
