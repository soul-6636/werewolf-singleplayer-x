import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_TYPES,
  addBeliefEvidence,
  addClaimNode,
  addClaimToMemory,
  appendPrivateEvent,
  appendPublicEvent,
  buildAgentContext,
  createAgentMemory,
  createClaimGraph,
  expireSecondOrderBeliefs,
  isExplicitSeerClaim,
  memoryPrompt,
  recordCommunication,
  refreshWolfCandidateSets,
  sanitizePublicSpeech,
  summarizeSimulationResults,
  validateReplayDocument,
  validateGameState,
  validatePublicSpeech,
  validatePublicSpeechEvidence,
  validateSeerSpeech
} from "../public/ai-core.js";

const players = [
  { id: "P1", seat: 0 },
  { id: "P2", seat: 1 },
  { id: "P3", seat: 2 }
];

test("agent memories keep public and private events isolated", () => {
  const first = createAgentMemory({ gameId: "g1", player: players[0], players });
  const second = createAgentMemory({ gameId: "g1", player: players[1], players });
  appendPublicEvent(first, { id: 1, day: 1, kind: "speech", text: "公开发言" });
  appendPublicEvent(second, { id: 1, day: 1, kind: "speech", text: "公开发言" });
  appendPrivateEvent(first, { id: "private_1", day: 1, kind: "seer-check", text: "2号是好人" });
  assert.equal(first.publicEvents.length, 1);
  assert.equal(second.publicEvents.length, 1);
  assert.equal(first.privateEvents.length, 1);
  assert.equal(second.privateEvents.length, 0);
  assert.equal(first.privateEvents[0].text, "2号是好人");
  assert.equal(second.privateEvents.length, 0);
  assert.match(memoryPrompt(first, () => "座位"), /上一轮推理摘要/);
});

test("claim graph preserves source events and marks contradictions", () => {
  const graph = createClaimGraph();
  const first = addClaimNode(graph, {
    day: 1,
    speakerId: "P1",
    speakerSeat: 1,
    type: CLAIM_TYPES.ROLE_CLAIM,
    targetId: "P1",
    targetSeat: 1,
    claimedValue: "seer",
    sourceEventId: 4
  });
  const second = addClaimNode(graph, {
    day: 2,
    speakerId: "P1",
    speakerSeat: 1,
    type: CLAIM_TYPES.ROLE_CLAIM,
    targetId: "P1",
    targetSeat: 1,
    claimedValue: "witch",
    sourceEventId: 9
  });
  assert.equal(first.status, "CONTRADICTED");
  assert.equal(second.status, "ACTIVE");
  assert.equal(first.sourceEventId, 4);
  assert.equal(second.sourceEventId, 9);
});

test("claim evidence updates only the receiving agent memory", () => {
  const memory = createAgentMemory({ gameId: "g1", player: players[0], players });
  const node = { id: "claim_1", speakerSeat: 1, targetId: "P2", targetSeat: 2, type: CLAIM_TYPES.SEER_RESULT_CLAIM, claimedValue: "werewolf", sourceEventId: 5, status: "ACTIVE" };
  addClaimToMemory(memory, node);
  assert.equal(memory.claims.length, 1);
  assert.equal(memory.beliefs.P2.suspicion, 42);
  assert.equal(memory.beliefs.P2.evidence[0].eventId, 5);
  assert.equal(memory.secondOrderBeliefs.length, 1);
  assert.equal(memory.secondOrderBeliefs[0].depth, 1);
  assert.equal(memory.informationBoundaryNotes[0].alternatives.length, 3);
  assert.equal(memory.motiveAnalyses[0].pushedTargetSeat, 2);
  assert.equal(memory.perspectiveAnalyses.length, 1);
  expireSecondOrderBeliefs(memory, 3);
  assert.equal(memory.secondOrderBeliefs.length, 0);
});

test("ordinary identity opinions do not receive seer-result weight", () => {
  const memory = createAgentMemory({ gameId: "g1", player: players[0], players });
  addClaimToMemory(memory, {
    id: "hypothesis_1",
    speakerSeat: 2,
    targetId: "P2",
    targetSeat: 2,
    type: CLAIM_TYPES.IDENTITY_HYPOTHESIS,
    claimedValue: "werewolf",
    sourceEventId: 6,
    status: "ACTIVE"
  });
  assert.equal(memory.beliefs.P2.suspicion, 20);
  assert.equal(memory.secondOrderBeliefs.length, 0);
});

test("wolf candidate sets never include the observing agent", () => {
  const memory = createAgentMemory({ gameId: "g1", player: players[0], players });
  addBeliefEvidence(memory, "P1", { delta: 25, eventId: 1, summary: "自我证据不应进入狼坑" });
  addBeliefEvidence(memory, "P2", { delta: 20, eventId: 2, summary: "公开行为" });
  refreshWolfCandidateSets(memory);
  assert.equal(memory.wolfCandidateSets[0].includes("P1"), false);
  assert.equal(memory.wolfCandidateSets[0].includes("P2"), true);
  assert.doesNotMatch(memoryPrompt(memory, (id) => id), /P1怀疑度/);
});

test("communication metadata stays finite and normalized", () => {
  const memory = createAgentMemory({ gameId: "g1", player: players[0], players });
  recordCommunication(memory, {
    sourceEventId: 7,
    day: 1,
    intent: "unknown",
    disclosureMode: "unknown",
    pressureLevel: "unknown",
    targetIds: ["P2", "P3", "P4", "P5"],
    expectedReaction: "回应站边"
  });
  assert.equal(memory.communicationLog.length, 1);
  assert.equal(memory.communicationLog[0].intent, "inform");
  assert.equal(memory.communicationLog[0].disclosureMode, "withhold");
  assert.equal(memory.communicationLog[0].pressureLevel, "low");
  assert.equal(memory.communicationLog[0].targetIds.length, 3);
});

test("public speech replaces names and internal IDs with seat labels", () => {
  const roster = [{ id: "P1", seat: 0, name: "宁安" }, { id: "P2", seat: 1, name: "江临" }];
  assert.equal(sanitizePublicSpeech("我怀疑宁安，P2也要解释。", roster), "我怀疑1号，2号也要解释。");
  const result = validatePublicSpeech("我怀疑宁安，P2也要解释。", roster);
  assert.equal(result.ok, true);
  assert.equal(result.text.includes("宁安"), false);
  assert.equal(result.text.includes("P2"), false);
});

test("public speech rejects unsupported sensory claims and overlong output", () => {
  assert.equal(validatePublicSpeech("我听到夜里有脚步声。", []).ok, false);
  assert.equal(validatePublicSpeech("x".repeat(181), []).ok, false);
  assert.equal(validatePublicSpeech("我只依据公开票型判断。", []).ok, true);
});

test("public speech evidence rejects invented roles and night causes", () => {
  const events = [
    { kind: "death", text: "4号被放逐出局。" },
    { kind: "death", text: "昨夜 3号出局。" },
    { kind: "speech", text: "2号自称女巫。" }
  ];
  assert.equal(validatePublicSpeechEvidence("4号出局是平民，已知2是女巫。", { speakerSeat: 1, publicEvents: events }).ok, false);
  assert.equal(validatePublicSpeechEvidence("昨晚3号大概率是女巫毒死的，感谢女巫。", { speakerSeat: 1, publicEvents: events }).ok, false);
  assert.equal(validatePublicSpeechEvidence("我怀疑4号是平民，但身份没有翻牌，不能确认。", { speakerSeat: 1, publicEvents: events }).ok, true);
});

test("public speech evidence accepts an explicit seer claim and public self-explosion", () => {
  assert.equal(validatePublicSpeechEvidence("我是预言家，4号是狼人。", { speakerSeat: 3, publicEvents: [] }).ok, true);
  assert.equal(validatePublicSpeechEvidence("我是3号预言家，4号是狼人。", { speakerSeat: 3, publicEvents: [] }).ok, true);
  assert.equal(validatePublicSpeechEvidence("3号自爆，公开确认是狼人。", {
    speakerSeat: 1,
    publicEvents: [{ kind: "death", text: "3号自爆，公开确认是狼人。" }]
  }).ok, true);
});

test("third-person seer references do not become identity claims", () => {
  assert.equal(isExplicitSeerClaim("5号跳预言家查3号金水"), false);
  assert.equal(isExplicitSeerClaim("我认为5号是预言家"), false);
  assert.equal(validatePublicSpeechEvidence("5号跳预言家查3号金水。3号是好人。", {
    speakerSeat: 6,
    publicEvents: []
  }).ok, false);
});

test("seer speech cannot invent an extra good result", () => {
  const checks = [{ targetSeat: 4, faction: "werewolf" }];
  assert.equal(validateSeerSpeech("我是3号预言家，4号是狼人。", { speakerSeat: 3, checks }).ok, true);
  assert.equal(validateSeerSpeech("我是3号预言家，4号是狼人，1号是好人。", { speakerSeat: 3, checks }).ok, false);
  assert.equal(validatePublicSpeechEvidence("3号是狼人，狼刀3。", { speakerSeat: 6, publicEvents: [], allowDeception: true }).ok, true);
});

test("game-state invariants detect public leaks and invalid memory visibility", () => {
  const roster = [
    { id: "P1", seat: 0, name: "甲甲", role: "werewolf", alive: true },
    { id: "P2", seat: 1, name: "乙乙", role: "werewolf", alive: true },
    { id: "P3", seat: 2, name: "丙丙", role: "villager", alive: true },
    { id: "P4", seat: 3, name: "丁丁", role: "villager", alive: true },
    { id: "P5", seat: 4, name: "戊戊", role: "seer", alive: true },
    { id: "P6", seat: 5, name: "己己", role: "witch", alive: true }
  ];
  const memories = Object.fromEntries(roster.map((player) => [player.id, createAgentMemory({ gameId: "g1", player, players: roster })]));
  const state = { id: "g1", players: roster, events: [{ id: 1, kind: "speech", text: "3号只依据公开票型判断。" }], phase: "night_wolf", night: {}, agentMemories: memories, ended: false };
  assert.deepEqual(validateGameState(state), []);
  const multiDeathState = {
    ...state,
    players: roster.map((player) => ({ ...player, alive: !["P4", "P5"].includes(player.id) })),
    events: [{ id: 1, kind: "death", text: "昨夜 4 号、5 号出局。" }],
    phase: "discussion"
  };
  assert.deepEqual(validateGameState(multiDeathState), []);
  state.events[0].text = "甲甲知道P2是狼人。";
  const errors = validateGameState(state);
  assert.equal(errors.some((error) => error.includes("公开发言")), true);
  appendPrivateEvent(memories.P3, { id: "wolf_1", kind: "wolf-room", text: "狼队计划" });
  assert.equal(validateGameState(state).some((error) => error.includes("非狼人读取狼队频道")), true);
});

test("agent context exposes only role-authorized private channels", () => {
  const player = { id: "P1", seat: 0, name: "甲甲" };
  const memory = createAgentMemory({ gameId: "g1", player, players: [player] });
  appendPrivateEvent(memory, { id: "wolf", kind: "wolf-room", day: 1, text: "狼队提案" });
  appendPrivateEvent(memory, { id: "seer", kind: "seer-check", day: 1, text: "2号是狼人" });
  appendPrivateEvent(memory, { id: "witch", kind: "witch-night", day: 1, text: "狼刀目标2号" });
  const input = {
    gameId: "g1",
    day: 1,
    phase: "discussion",
    memory,
    aliveSeats: [1, 2],
    publicRounds: [],
    currentRoundEvents: [],
    voteHistory: [],
    teammates: [2],
    wolfRoom: { messages: ["狼队提案"], proposals: [], plan: null },
    seerResults: ["2号=狼人"],
    witchState: { saveAvailable: true, poisonAvailable: true },
    legalActions: [],
    persona: "谨慎",
    promptVersion: "v1"
  };
  const wolf = buildAgentContext({ ...input, self: { id: "P1", seat: 1, role: "werewolf", faction: "werewolf" } });
  const seer = buildAgentContext({ ...input, self: { id: "P1", seat: 1, role: "seer", faction: "village" } });
  const witch = buildAgentContext({ ...input, self: { id: "P1", seat: 1, role: "witch", faction: "village" } });
  const villager = buildAgentContext({ ...input, self: { id: "P1", seat: 1, role: "villager", faction: "village" } });
  assert.equal(Boolean(wolf.wolfRoom), true);
  assert.equal(Boolean(wolf.roleFacts), false);
  assert.equal(Boolean(seer.wolfRoom), false);
  assert.deepEqual(seer.roleFacts.seerResults, ["2号=狼人"]);
  assert.equal(Boolean(witch.wolfRoom), false);
  assert.deepEqual(witch.roleFacts.witchState, { saveAvailable: true, poisonAvailable: true });
  assert.equal(Boolean(villager.wolfRoom), false);
  assert.equal(Boolean(villager.roleFacts), false);
  assert.deepEqual(villager.self.privateEvents, []);
});

test("replay documents validate roster, event order, and public boundaries", () => {
  const replay = {
    version: 1,
    gameId: "g_7",
    phase: "ended",
    players: [
      { id: "P1", seat: 0, name: "甲甲", role: "werewolf", alive: false },
      { id: "P2", seat: 1, name: "乙乙", role: "werewolf", alive: true },
      { id: "P3", seat: 2, name: "丙丙", role: "villager", alive: true },
      { id: "P4", seat: 3, name: "丁丁", role: "villager", alive: true },
      { id: "P5", seat: 4, name: "戊戊", role: "seer", alive: true },
      { id: "P6", seat: 5, name: "己己", role: "witch", alive: true }
    ],
    events: [
      { id: 1, day: 1, kind: "speech", actor: "1号", text: "我只根据公开票型判断。" },
      { id: 2, day: 1, kind: "death", actor: "系统", text: "1号被放逐出局。" }
    ]
  };
  assert.deepEqual(validateReplayDocument(replay), []);
  const invalid = {
    ...replay,
    events: [{ id: 2, day: 1, kind: "speech", actor: "1号", text: "甲甲知道P2是狼人。" }]
  };
  assert.equal(validateReplayDocument(invalid).length > 0, true);
});

test("simulation summary reports completion, winners, and model metrics", () => {
  const summary = summarizeSimulationResults([
    { phase: "ended", winner: "village", day: 3, actions: 8, aiActions: 7, modelCalls: 2, modelRetries: 1, fallbacks: 1, invariantErrors: [] },
    { phase: "ended", winner: "werewolf", day: 2, actions: 6, aiActions: 5, modelCalls: 0, modelRetries: 0, fallbacks: 0, invariantErrors: [] },
    { phase: "vote", winner: null, day: 30, actions: 4, aiActions: 3, invariantErrors: ["未结束"] }
  ]);
  assert.equal(summary.count, 3);
  assert.equal(summary.completed, 2);
  assert.equal(summary.failures.length, 1);
  assert.deepEqual(summary.winners, { village: 1, werewolf: 1, unfinished: 1 });
  assert.equal(summary.modelCalls, 2);
  assert.equal(summary.modelRetries, 1);
  assert.equal(summary.fallbacks, 1);
  assert.equal(summary.averageAiActions, 5);
});
