export const DISCLOSURE_MODES = Object.freeze([
  "reveal_now",
  "partial_reveal",
  "withhold",
  "delay_until_pressured",
  "bluff"
]);

const VALID_ROLES = new Set(["werewolf", "villager", "seer", "witch"]);

function freezeList(value) {
  return Object.freeze((Array.isArray(value) ? value : []).map((item) => String(item)).slice(0, 8));
}

export function planDisclosure({ role, pressureLevel = "low", hasUnreportedSeerResults = false, claimsSeer = false, forced = null } = {}) {
  const normalizedRole = VALID_ROLES.has(role) ? role : "villager";
  let mode = "withhold";
  let intent = "observe";
  let allowedFactTypes = [];

  if (normalizedRole === "seer" && hasUnreportedSeerResults) {
    mode = "reveal_now";
    intent = "declare_private_results";
    allowedFactTypes = ["role_claim", "seer_result"];
  } else if (normalizedRole === "werewolf" && claimsSeer) {
    mode = "bluff";
    intent = "misdirect_and_create_vote_pressure";
    allowedFactTypes = ["public_claim_only"];
  } else if (pressureLevel === "high" || pressureLevel === "sacrifice") {
    mode = normalizedRole === "witch" ? "partial_reveal" : "delay_until_pressured";
    intent = "answer_pressure_without_overclaiming";
    allowedFactTypes = normalizedRole === "witch" ? ["role_claim"] : [];
  }

  if (DISCLOSURE_MODES.includes(forced)) mode = forced;
  return Object.freeze({
    version: 1,
    role: normalizedRole,
    mode,
    intent,
    allowedFactTypes: freezeList(allowedFactTypes),
    privateFactValues: Object.freeze([]),
    pressureLevel: String(pressureLevel),
    claimsSeer: Boolean(claimsSeer)
  });
}

export function disclosureCanExpose(plan, factType) {
  return Boolean(plan && plan.allowedFactTypes.includes(String(factType)));
}

export function validateDisclosurePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") return ["披露方案不是对象"];
  if (!DISCLOSURE_MODES.includes(plan.mode)) errors.push("披露模式不合法");
  if ((plan.privateFactValues || []).length) errors.push("披露方案不得保存私密事实值");
  if (!Array.isArray(plan.allowedFactTypes)) errors.push("披露方案缺少允许披露类型");
  return errors;
}
