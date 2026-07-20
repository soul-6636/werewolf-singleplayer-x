const MAX_REASONING_CHARS = 180;
const MAX_EXPECTED_REACTION_CHARS = 120;

function limitedText(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function frozenList(value, limit = 8) {
  return Object.freeze((Array.isArray(value) ? value : []).slice(0, limit));
}

export function planStrategy({
  kind,
  action = null,
  targetId = null,
  legalTargets = [],
  reasoningSummary = "",
  communicationIntent = null,
  disclosureMode = null,
  pressureLevel = null,
  targetIds = [],
  expectedReaction = "",
  evidence = []
} = {}) {
  if (!kind) throw new Error("StrategyPlanner 缺少决策类型");
  const targets = [...legalTargets];
  if (targetId !== null && targetId !== undefined && targets.length && !targets.includes(targetId)) {
    throw new Error("StrategyPlanner 选择了非法目标");
  }
  return Object.freeze({
    version: 1,
    kind: String(kind),
    action: action || (kind === "speech" ? "speak" : null),
    targetId: targetId ?? null,
    legalTargets: frozenList(targets, 24),
    reasoningSummary: limitedText(reasoningSummary, MAX_REASONING_CHARS),
    communicationIntent: communicationIntent || null,
    disclosureMode: disclosureMode || null,
    pressureLevel: pressureLevel || null,
    targetIds: frozenList(targetIds, 3),
    expectedReaction: limitedText(expectedReaction, MAX_EXPECTED_REACTION_CHARS),
    evidence: frozenList(evidence, 8)
  });
}

export function generateSpeechFromPlan(plan, speech, { validateSpeech } = {}) {
  if (!plan || plan.kind !== "speech") throw new Error("SpeechGenerator 只能处理发言策略");
  const raw = String(speech || "").trim();
  if (!raw) throw new Error("SpeechGenerator 收到空文本");
  const checked = typeof validateSpeech === "function" ? validateSpeech(raw) : { ok: true, text: raw };
  if (!checked?.ok) throw new Error(checked.reason || "发言未通过校验");
  return Object.freeze({
    action: plan.action,
    targetId: plan.targetId,
    speech: String(checked.text ?? raw).trim(),
    reasoningSummary: plan.reasoningSummary,
    communicationIntent: plan.communicationIntent,
    disclosureMode: plan.disclosureMode,
    pressureLevel: plan.pressureLevel,
    targetIds: plan.targetIds,
    expectedReaction: plan.expectedReaction,
    strategyVersion: plan.version
  });
}

export function serializeStrategyPlan(plan) {
  if (!plan) return null;
  return {
    version: plan.version,
    kind: plan.kind,
    action: plan.action,
    targetId: plan.targetId,
    legalTargets: [...plan.legalTargets],
    reasoningSummary: plan.reasoningSummary,
    communicationIntent: plan.communicationIntent,
    disclosureMode: plan.disclosureMode,
    pressureLevel: plan.pressureLevel,
    targetIds: [...plan.targetIds],
    expectedReaction: plan.expectedReaction,
    evidence: [...plan.evidence]
  };
}
