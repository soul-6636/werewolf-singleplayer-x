import test from "node:test";
import assert from "node:assert/strict";
import { validatePublicSpeechEvidence } from "../public/ai-core.js";
import {
  claimsFromSpeechActs,
  normalizeSpeechActs,
  resolveSpeechDelivery,
  validateSpeechActs
} from "../public/speech-acts.js";

test("future witch advice is a valid speech act but never becomes a factual claim", () => {
  const acts = normalizeSpeechActs([
    { type: "ACTION_ADVICE", role: "witch", action: "hold_poison" }
  ]);
  const validation = validateSpeechActs(acts, { speakerRole: "villager", speakerSeat: 2 });

  assert.equal(validation.ok, true);
  assert.deepEqual(validation.acceptedActs, acts);
  assert.deepEqual(claimsFromSpeechActs(validation.acceptedActs), []);
});

test("referencing another seer's result never becomes the current speaker's own check", () => {
  const acts = normalizeSpeechActs([
    { type: "REFERENCE_CLAIM", speakerSeat: 2, targetSeat: 1, claimType: "SEER_RESULT", result: "werewolf" }
  ]);
  const validation = validateSpeechActs(acts, { speakerRole: "seer", speakerSeat: 6 });

  assert.equal(validation.ok, true);
  assert.deepEqual(validation.acceptedActs, [{
    type: "REFERENCE_CLAIM",
    speakerSeat: 2,
    targetSeat: 1,
    claimType: "SEER_RESULT",
    result: "werewolf"
  }]);
  assert.deepEqual(claimsFromSpeechActs(validation.acceptedActs), []);
});

test("a real seer's structured result is accepted only as the speaker's own factual claim", () => {
  const acts = normalizeSpeechActs([
    { type: "ROLE_CLAIM", role: "seer" },
    { type: "SEER_RESULT", targetSeat: 3, result: "village" }
  ]);
  const validation = validateSpeechActs(acts, {
    speakerRole: "seer",
    speakerSeat: 6,
    seerChecks: [{ targetSeat: 3, result: "village" }]
  });

  assert.equal(validation.ok, true);
  assert.deepEqual(validation.acceptedActs, [
    { type: "ROLE_CLAIM", role: "seer" },
    { type: "SEER_RESULT", targetSeat: 3, result: "village" }
  ]);
  assert.deepEqual(claimsFromSpeechActs(validation.acceptedActs), validation.acceptedActs);
});

test("an invalid structured seer result is rejected without accepting it as public evidence", () => {
  const validation = validateSpeechActs([
    { type: "ROLE_CLAIM", role: "seer" },
    { type: "SEER_RESULT", targetSeat: 1, result: "werewolf" }
  ], {
    speakerRole: "seer",
    speakerSeat: 4,
    seerChecks: [{ targetSeat: 2, result: "village" }]
  });

  assert.equal(validation.ok, false);
  assert.deepEqual(claimsFromSpeechActs(validation.acceptedActs), [{ type: "ROLE_CLAIM", role: "seer" }]);
  assert.match(validation.errors.join("；"), /真实记录不一致/);
});

test("ambiguous natural-language audits can fall back but can never pause the game", () => {
  const advice = normalizeSpeechActs([
    { type: "ACTION_ADVICE", role: "witch", action: "hold_poison" }
  ]);
  assert.deepEqual(resolveSpeechDelivery({
    acceptedActs: advice,
    semanticWarnings: ["公开事件没有公布毒药来源"]
  }), { reject: false, useFallback: false });
  assert.deepEqual(resolveSpeechDelivery({
    acceptedActs: [],
    semanticWarnings: ["自然语言含义不确定"]
  }), { reject: false, useFallback: true });
});

test("the real 'hold poison' sentence stays publishable even when the legacy regex warns", () => {
  const speech = "建议女巫先别毒，其他玩家也别急着出我，万一我被推出局是好人，你1号就坐实了。";
  const legacyAudit = validatePublicSpeechEvidence(speech, {
    speakerSeat: 2,
    speakerRole: "villager",
    publicEvents: []
  });
  const advice = normalizeSpeechActs([
    { type: "ACTION_ADVICE", role: "witch", action: "hold_poison" }
  ]);

  assert.equal(legacyAudit.ok, false);
  assert.deepEqual(resolveSpeechDelivery({
    acceptedActs: advice,
    semanticWarnings: [legacyAudit.reason]
  }), { reject: false, useFallback: false });
});
