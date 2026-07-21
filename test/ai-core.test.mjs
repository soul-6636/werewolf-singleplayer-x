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
  extractPublicSeerClaim,
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
  validateSeerSpeech,
  validateSpeechTargets,
  validateWitchSpeech
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

test("a false seer result against self becomes private hard evidence against its speaker", () => {
  const roster = [
    { id: "P1", seat: 0, role: "villager" },
    { id: "P2", seat: 1, role: "werewolf" },
    { id: "P3", seat: 2, role: "witch" }
  ];
  const witchMemory = createAgentMemory({ gameId: "g1", player: roster[2], players: roster });
  const observerMemory = createAgentMemory({ gameId: "g1", player: roster[0], players: roster });
  const claim = {
    id: "claim_self_check",
    day: 1,
    speakerId: "P2",
    speakerSeat: 2,
    targetId: "P3",
    targetSeat: 3,
    type: CLAIM_TYPES.SEER_RESULT_CLAIM,
    claimedValue: "werewolf",
    sourceEventId: 5,
    status: "ACTIVE"
  };

  addClaimToMemory(witchMemory, claim);
  addClaimToMemory(observerMemory, claim);

  assert.equal(witchMemory.claims[0].status, "CONTRADICTED_BY_SELF_KNOWLEDGE");
  assert.equal(witchMemory.selfKnowledgeConflicts.length, 1);
  assert.equal(witchMemory.beliefs.P2.suspicion >= 75, true);
  assert.equal(witchMemory.wolfCandidateSets[0][0], "P2");
  assert.match(memoryPrompt(witchMemory, (id) => `${roster.find((player) => player.id === id).seat + 1}号`), /自身真值反证.*2号.*不可能是真预言家/);

  assert.equal(observerMemory.claims[0].status, "ACTIVE");
  assert.equal(observerMemory.selfKnowledgeConflicts.length, 0);
  assert.equal(observerMemory.beliefs.P2.suspicion, 20);
  assert.doesNotMatch(memoryPrompt(observerMemory, (id) => id), /自身真值反证：.*不可能是真预言家/);
});

test("a correct result about self supports only the claim content, not the seer identity", () => {
  const roster = [
    { id: "P1", seat: 0, role: "werewolf" },
    { id: "P2", seat: 1, role: "witch" }
  ];
  const memory = createAgentMemory({ gameId: "g1", player: roster[1], players: roster });
  addClaimToMemory(memory, {
    id: "claim_self_good",
    day: 1,
    speakerId: "P1",
    speakerSeat: 1,
    targetId: "P2",
    targetSeat: 2,
    type: CLAIM_TYPES.SEER_RESULT_CLAIM,
    claimedValue: "village",
    sourceEventId: 6,
    status: "ACTIVE"
  });

  assert.equal(memory.claims[0].status, "SUPPORTED_BY_SELF_KNOWLEDGE");
  assert.equal(memory.selfKnowledgeConflicts.length, 0);
  assert.equal(memory.beliefs.P1.suspicion, 20);
  assert.match(memoryPrompt(memory, (id) => `${roster.find((player) => player.id === id).seat + 1}号`), /自身真值印证.*不能证明.*真预言家/);
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
  assert.equal(validatePublicSpeechEvidence("昨晚3号是女巫毒死的，感谢女巫。", { speakerSeat: 1, publicEvents: events }).ok, false);
  assert.equal(validatePublicSpeechEvidence("我怀疑昨晚3号可能是女巫毒死的，但公开没有确认，先结合票型验证。", { speakerSeat: 1, publicEvents: events }).ok, true);
  assert.equal(validatePublicSpeechEvidence("昨晚刀口是3号。", { speakerSeat: 5, publicEvents: events, allowDeception: true }).ok, false);
  assert.equal(validatePublicSpeechEvidence("我们狼队昨夜选择了3号。", { speakerSeat: 5, publicEvents: events, allowDeception: true }).ok, false);
  assert.equal(validatePublicSpeechEvidence("3号昨晚吃刀出局。", { speakerSeat: 5, publicEvents: events, allowDeception: true }).ok, false);
  assert.equal(validatePublicSpeechEvidence("3号倒在狼人的袭击下。", { speakerSeat: 5, publicEvents: events, allowDeception: true }).ok, false);
  assert.equal(validatePublicSpeechEvidence("我怀疑昨晚刀口可能是3号，仍然待验证。", { speakerSeat: 1, publicEvents: events }).ok, true);
  assert.equal(validatePublicSpeechEvidence("我怀疑可能是毒，实际狼刀3号。", { speakerSeat: 5, publicEvents: events, allowDeception: true }).ok, false);
  assert.equal(validatePublicSpeechEvidence("我怀疑4号是平民，但身份没有翻牌，不能确认。", { speakerSeat: 1, publicEvents: events }).ok, true);
});

test("role-aware evidence validation separates authorized claims from fabricated roles", () => {
  assert.equal(validatePublicSpeechEvidence("我是预言家，4号是狼人。", {
    speakerSeat: 3,
    speakerRole: "villager",
    publicEvents: []
  }).ok, false);
  assert.equal(validatePublicSpeechEvidence("我是女巫，昨晚狼刀3号，我用解药救了3号。", {
    speakerSeat: 6,
    speakerRole: "witch",
    publicEvents: []
  }).ok, true);
  assert.equal(validatePublicSpeechEvidence("我是女巫，昨晚狼刀3号。", {
    speakerSeat: 2,
    speakerRole: "villager",
    publicEvents: []
  }).ok, false);
  assert.equal(validatePublicSpeechEvidence("我是预言家，4号是狼人。", {
    speakerSeat: 5,
    speakerRole: "werewolf",
    publicEvents: [],
    allowDeception: true
  }).ok, true);
});

test("night-cause validation allows attributed challenges without accepting direct assertions", () => {
  const challengedSpeech = "我是预言家，昨晚查验4号是好人。1号自称预言家查杀我，但他的发言暴露了上帝视角——如何知道5号被毒、6号被刀？狼人才可能知道死因细节。4号已经认我金水并指出1号漏洞，请3号看清局势：1号悍跳狼，我才是真预言家。今天放逐1号，好人稳赢。";
  assert.equal(validatePublicSpeechEvidence(challengedSpeech, {
    speakerSeat: 2,
    speakerRole: "seer",
    publicEvents: []
  }).ok, true);
  assert.equal(validatePublicSpeechEvidence("1号声称5号被毒、6号被刀，我不认可这个说法。", {
    speakerSeat: 2,
    speakerRole: "seer",
    publicEvents: []
  }).ok, true);
  assert.equal(validatePublicSpeechEvidence("5号被毒、6号被刀，这一点已经确定。", {
    speakerSeat: 2,
    speakerRole: "seer",
    publicEvents: []
  }).ok, false);
  assert.equal(validatePublicSpeechEvidence("1号说5号被毒、6号被刀，我认为他说得对。", {
    speakerSeat: 2,
    speakerRole: "seer",
    publicEvents: []
  }).ok, false);
});

test("night-cause validation does not read negated certainty as confirmation", () => {
  const speech = "2号声称女巫，刀口1号，毒4号，但系统未确认刀毒来源。我推测1号可能是狼刀目标，4号被毒但身份未知。作为平民，我们尚无有效查验，建议不要轻信任何身份声明。今天放逐应优先从2、5、6中找出矛盾点，尤其观察谁急于带节奏或跟风。另外，如果2号是真女巫，狼人今晚可能会刀他，他应提前安排救药或留逻辑。我暂持观望，需要更多发言验证。";
  assert.equal(validatePublicSpeechEvidence(speech, {
    speakerSeat: 3,
    speakerRole: "villager",
    publicEvents: []
  }).ok, true);
  for (const cautiousSpeech of [
    "系统尚未确认5号被毒、6号被刀。",
    "目前未确定5号被毒、6号被刀。",
    "公开信息从未证明5号被毒、6号被刀。"
  ]) {
    assert.equal(validatePublicSpeechEvidence(cautiousSpeech, {
      speakerSeat: 3,
      speakerRole: "villager",
      publicEvents: []
    }).ok, true);
  }
  assert.equal(validatePublicSpeechEvidence("系统已经确认5号被毒、6号被刀。", {
    speakerSeat: 3,
    speakerRole: "villager",
    publicEvents: []
  }).ok, false);
});

test("extracts both true and bluff seer declarations as public claims", () => {
  const bluff = extractPublicSeerClaim("我是5号预言家，昨晚查验3号，他是好人。", { speakerId: "P5", speakerSeat: 5, day: 1 });
  assert.equal(bluff.playerId, "P5");
  assert.deepEqual(bluff.checks, [{ targetSeat: 3, faction: "village" }]);
  const direct = extractPublicSeerClaim("我是预言家，2号是狼人。", { speakerId: "P4", speakerSeat: 4, day: 1 });
  assert.deepEqual(direct.checks, [{ targetSeat: 2, faction: "werewolf" }]);
  const attributed = extractPublicSeerClaim("我是5号预言家，1号说2号是狼人，昨晚验3号是好人。", { speakerId: "P5", speakerSeat: 5, day: 1 });
  assert.deepEqual(attributed.checks, [{ targetSeat: 3, faction: "village" }]);
  assert.equal(extractPublicSeerClaim("我认为5号是预言家，2号可能是狼人。", { speakerId: "P1", speakerSeat: 1, day: 1 }), null);
});

test("a seer transcript keeps the speaker's own check separate from quoted claims and table talk", () => {
  const speech = "我是预言家，昨晚查验3号是好人。2号自称预言家查杀1号，但未对跳时声明需审慎。1号首位发言无实质反驳，但也不能仅凭查杀认定狼人。";
  const claim = extractPublicSeerClaim(speech, { speakerId: "P5", speakerSeat: 6, day: 1 });
  assert.deepEqual(claim.checks, [{ targetSeat: 3, faction: "village" }]);
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
  assert.equal(validateSeerSpeech("我是6号预言家，昨晚查验了3号，他是好人。", { speakerSeat: 6, checks: [{ targetSeat: 3, faction: "village" }] }).ok, true);
  assert.equal(validateSeerSpeech("我是6号预言家，昨晚查验3号，结果为好人。", { speakerSeat: 6, checks: [{ targetSeat: 3, faction: "village" }] }).ok, true);
  assert.equal(validateSeerSpeech("我是6号预言家，3号不是狼人，是好人。", { speakerSeat: 6, checks: [{ targetSeat: 3, faction: "village" }] }).ok, true);
  assert.equal(validateSeerSpeech("我是6号预言家，我认为2号大概率是狼人；昨晚查验3号，结果是好人。", { speakerSeat: 6, checks: [{ targetSeat: 3, faction: "village" }] }).ok, true);
  assert.equal(validateSeerSpeech("我是6号预言家，1号说2号是狼人。昨晚查验3号，结果是好人。", { speakerSeat: 6, checks: [{ targetSeat: 3, faction: "village" }] }).ok, true);
  assert.equal(validatePublicSpeechEvidence("3号是狼人。", { speakerSeat: 6, publicEvents: [], allowDeception: true }).ok, true);
  assert.equal(validatePublicSpeechEvidence("3号是狼人，昨晚我们狼刀3号。", { speakerSeat: 6, publicEvents: [], allowDeception: true }).ok, false);
  assert.equal(validatePublicSpeechEvidence("我怀疑昨晚可能是狼刀3号，仍然待验证。", { speakerSeat: 6, publicEvents: [], allowDeception: true }).ok, true);
});

test("seer may withhold or partially reveal but cannot alter a revealed result", () => {
  const checks = [
    { targetSeat: 2, faction: "werewolf" },
    { targetSeat: 4, faction: "village" }
  ];
  assert.equal(validateSeerSpeech("我先听完这一轮发言再决定是否公开身份。", {
    speakerSeat: 6,
    checks,
    requireAll: false
  }).ok, true);
  assert.equal(validateSeerSpeech("我是预言家，2号是狼人。", {
    speakerSeat: 6,
    checks,
    requireAll: false
  }).ok, true);
  assert.equal(validateSeerSpeech("我是预言家，2号是好人。", {
    speakerSeat: 6,
    checks,
    requireAll: false
  }).ok, false);
  assert.equal(validateSeerSpeech("昨晚查验2号是狼人。", {
    speakerSeat: 6,
    checks,
    requireAll: false
  }).ok, false);
});

test("seer validation allows attributed checks and uncertain table reads alongside a real check", () => {
  const speech = "我是预言家，昨晚查验2号是好人。3号自称预言家查杀1号，但1号跳女巫救了我。目前有两个预言家对跳，我建议先听1号女巫进一步解释为何救我，以及3号对跳的查验逻辑。今天放逐1号或3号，我倾向先放逐3号，因为我的查验信息是2号好人，而3号查杀1号可能为狼人身份。";
  assert.equal(validateSeerSpeech(speech, {
    speakerSeat: 4,
    checks: [{ targetSeat: 2, faction: "village" }],
    requireAll: false
  }).ok, true);
});

test("witch may reveal only night facts that match her own action record", () => {
  const facts = { killTargetSeat: 3, action: "save", poisonTargetSeat: null };
  assert.equal(validateWitchSpeech("我是女巫，昨晚刀口是3号，我用了解药。", facts).ok, true);
  assert.equal(validateWitchSpeech("我是女巫，昨晚刀口是4号，我用了解药。", facts).ok, false);
  assert.equal(validateWitchSpeech("我是女巫，昨晚刀口是3号，但我没有用药。", facts).ok, false);
  assert.equal(validateWitchSpeech("我是女巫，昨晚我毒了2号。", facts).ok, false);
  assert.equal(validateWitchSpeech("我只根据公开票型判断。", facts).ok, true);
});

test("a public self-explosion does not reveal unrelated night causes", () => {
  const events = [
    { kind: "death", text: "3号自爆，公开确认是狼人。" },
    { kind: "death", text: "昨夜4号出局。" }
  ];
  assert.equal(validatePublicSpeechEvidence("昨晚4号被狼刀了。", { speakerSeat: 1, publicEvents: events }).ok, false);
});

test("living players cannot request new responses from eliminated seats", () => {
  const state = { aliveSeats: [1, 2, 3, 5] };
  assert.equal(validateSpeechTargets("请6号补充今天的怀疑对象和归票理由。", state).ok, false);
  assert.equal(validateSpeechTargets("6号请你回应一下昨天的票型。", state).ok, false);
  assert.equal(validateSpeechTargets("回看6号昨天的解释，我认为2号应该回应。", state).ok, true);
  assert.equal(validateSpeechTargets("请2号解释今天为什么改票。", state).ok, true);
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
