import test from "node:test";
import assert from "node:assert/strict";
import { generateSpeechFromPlan, planStrategy, serializeStrategyPlan } from "../public/ai-strategy.js";

test("StrategyPlanner freezes legal action and immutable planning metadata", () => {
  const plan = planStrategy({
    kind: "vote",
    action: null,
    targetId: "P2",
    legalTargets: ["P2", "P3"],
    reasoningSummary: "依据公开票型",
    disclosureMode: "withhold",
    evidence: [{ eventId: 4, summary: "公开投票" }]
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.legalTargets), true);
  assert.equal(plan.targetId, "P2");
  assert.throws(() => planStrategy({ kind: "vote", targetId: "P9", legalTargets: ["P2"] }), /非法目标/);
  const copy = serializeStrategyPlan(plan);
  assert.deepEqual(copy.evidence, [{ eventId: 4, summary: "公开投票" }]);
  assert.notEqual(copy, plan);
});

test("SpeechGenerator can bind text but cannot rewrite frozen strategy fields", () => {
  const plan = planStrategy({
    kind: "speech",
    action: "speak",
    targetId: null,
    reasoningSummary: "只使用公开信息",
    communicationIntent: "probe",
    disclosureMode: "withhold",
    pressureLevel: "low",
    targetIds: ["P2"]
  });
  let validatorCalls = 0;
  const generated = generateSpeechFromPlan(plan, "请 2 号解释自己的票型。", {
    privateFacts: ["狼刀目标"],
    validateSpeech: (text) => {
      validatorCalls += 1;
      return { ok: true, text };
    }
  });
  assert.equal(validatorCalls, 1);
  assert.equal(generated.action, "speak");
  assert.equal(generated.targetId, null);
  assert.equal(generated.communicationIntent, "probe");
  assert.equal(generated.speech, "请 2 号解释自己的票型。");
  assert.equal("privateFacts" in generated, false);
  assert.equal(generated.strategyVersion, 1);
  assert.throws(() => generateSpeechFromPlan(plan, "", { validateSpeech: () => ({ ok: true, text: "" }) }), /空文本/);
});
