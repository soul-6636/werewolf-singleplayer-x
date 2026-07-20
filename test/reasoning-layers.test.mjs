import test from "node:test";
import assert from "node:assert/strict";
import { createAgentMemory, recordDeception, reconcileMemoryDeceptions, snapshotMemory } from "../public/ai-core.js";
import { disclosureCanExpose, planDisclosure, validateDisclosurePlan } from "../public/ai-disclosure.js";
import { evaluateSituation, getWinner, simulateLegalBranch } from "../public/ai-situation.js";
import { generateContextualBotSpeech, generateLastWordsSpeech, speechFingerprint } from "../public/ai-speech.js";
import { addDeception, createDeceptionLedger, updateDeceptionStatus } from "../public/ai-deception.js";
import { appendStoredEvent, createStoredEvent, readStoredEvents } from "../server/jsonl.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roster = [
  { id: "W1", role: "werewolf", alive: true },
  { id: "W2", role: "werewolf", alive: true },
  { id: "V1", role: "villager", alive: true },
  { id: "V2", role: "villager", alive: true },
  { id: "S1", role: "seer", alive: true },
  { id: "T1", role: "witch", alive: true }
];

test("SituationEvaluator simulates legal vote branches and terminal winners", () => {
  const state = roster.map((player) => ({ ...player, alive: !["V1", "S1"].includes(player.id) }));
  assert.equal(getWinner(state), null);
  const branch = simulateLegalBranch({ players: state, phase: "vote", action: { targetId: "T1" } });
  assert.equal(branch.winner, "werewolf");
  const evaluation = evaluateSituation({ players: state, phase: "vote", day: 2, legalActions: [{ targetId: "T1" }, { targetId: "V2" }] });
  assert.equal(evaluation.branchCount, 2);
  assert.equal(evaluation.terminalBranchCount, 2);
  assert.equal(evaluation.branches.find((item) => item.action.targetId === "T1").winner, "werewolf");
});

test("DisclosurePlanner exposes only authorized fact types", () => {
  const seer = planDisclosure({ role: "seer", hasUnreportedSeerResults: true });
  const villager = planDisclosure({ role: "villager", pressureLevel: "high" });
  const wolf = planDisclosure({ role: "werewolf", claimsSeer: true });
  assert.equal(seer.mode, "reveal_now");
  assert.equal(disclosureCanExpose(seer, "seer_result"), true);
  assert.equal(disclosureCanExpose(villager, "seer_result"), false);
  assert.equal(wolf.mode, "bluff");
  assert.deepEqual(validateDisclosurePlan(seer), []);
  assert.deepEqual(seer.privateFactValues, []);
});

test("DeceptionLedger keeps immutable history and marks conflicting claims", () => {
  const ledger = createDeceptionLedger();
  const first = addDeception(ledger, { day: 1, claimedRole: "seer", claimedResults: [{ seat: 2, faction: "village" }], stopLossAction: "切割" });
  const previous = JSON.stringify(ledger.history[0].entry);
  const memory = createAgentMemory({ gameId: "g1", player: { id: "W1", seat: 0 }, players: [{ id: "W1", seat: 0 }] });
  recordDeception(memory, { day: 1, claimedRole: "seer", claimedResults: [{ seat: 2, faction: "village" }] });
  const conflicts = reconcileMemoryDeceptions(memory, { day: 2, sourceEventId: 8, claimedRole: "witch" });
  assert.equal(conflicts.length, 1);
  assert.equal(first.status, "ACTIVE");
  updateDeceptionStatus(ledger, first.id, "MITIGATED", "已撤回身份");
  assert.equal(JSON.stringify(ledger.history[ledger.history.length - 1].entry), previous);
  assert.equal(ledger.entries[0].status, "MITIGATED");
  assert.equal(snapshotMemory(memory).deceptionLedger.version, 1);
});

test("JSONL event layer appends and restores stable stored events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "werewolf-jsonl-"));
  const file = join(dir, "g_33.jsonl");
  try {
    const event = createStoredEvent({ sequence: 1, gameId: "g_33", type: "speech", payload: { text: "公开发言" } });
    await appendStoredEvent(file, event);
    await appendStoredEvent(file, { sequence: 2, gameId: "g_33", type: "death", payload: { seat: 3 } });
    const restored = await readStoredEvents(file);
    assert.equal(restored.length, 2);
    assert.equal(restored[1].payload.seat, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contextual Bot speeches are distinct and grounded in public discussion", () => {
  const base = {
    role: "villager",
    persona: "谨慎克制",
    day: 2,
    aliveSeats: [1, 2, 3, 4, 5],
    recentEvents: [
      { kind: "death", text: "昨夜 6 号出局。" },
      { kind: "speech", speakerSeat: 1, text: "我建议大家明确报出怀疑对象。" }
    ],
    publicClaims: [],
    previousSpeeches: []
  };
  const first = generateContextualBotSpeech({ ...base, selfSeat: 2, turn: 1 });
  const second = generateContextualBotSpeech({ ...base, selfSeat: 3, turn: 2, previousSpeeches: [first.speech] });
  assert.notEqual(speechFingerprint(first.speech), speechFingerprint(second.speech));
  assert.match(first.speech, /1号|2号|3号|4号|5号/);
  assert.match(second.speech, /1号|2号|3号|4号|5号/);
  assert.match(first.reasoningSummary, /公开发言|票型|判断/);
});

test("last words acknowledge elimination instead of continuing live discussion", () => {
  const result = generateLastWordsSpeech({ selfSeat: 5, role: "villager" });
  assert.match(result.speech, /已经被放逐|已经出局/);
  assert.doesNotMatch(result.speech, /我想听|请.*解释|下一轮我/);
});
