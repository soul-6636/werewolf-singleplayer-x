export const SPEECH_ACT_TYPES = Object.freeze({
  ROLE_CLAIM: "ROLE_CLAIM",
  SEER_RESULT: "SEER_RESULT",
  WITCH_ACTION_CLAIM: "WITCH_ACTION_CLAIM",
  REFERENCE_CLAIM: "REFERENCE_CLAIM",
  SUSPICION: "SUSPICION",
  ACTION_ADVICE: "ACTION_ADVICE",
  CHALLENGE: "CHALLENGE"
});

const KNOWN_TYPES = new Set(Object.values(SPEECH_ACT_TYPES));
const KNOWN_ROLES = new Set(["werewolf", "villager", "seer", "witch"]);

function seat(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 6 ? number : null;
}

function faction(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["werewolf", "wolf", "狼人", "狼", "查杀"].includes(normalized)) return "werewolf";
  if (["village", "villager", "good", "好人", "平民", "金水"].includes(normalized)) return "village";
  return null;
}

export function normalizeSpeechActs(value) {
  const acts = [];
  for (const raw of (Array.isArray(value) ? value : []).slice(0, 12)) {
    if (!raw || typeof raw !== "object") continue;
    const type = String(raw.type || "").trim().toUpperCase();
    if (!KNOWN_TYPES.has(type)) continue;
    if (type === SPEECH_ACT_TYPES.ACTION_ADVICE) {
      const role = String(raw.role || "").trim().toLowerCase();
      const action = String(raw.action || "").trim().toLowerCase();
      if (!KNOWN_ROLES.has(role) || !action) continue;
      acts.push({ type, role, action });
      continue;
    }
    if (type === SPEECH_ACT_TYPES.ROLE_CLAIM) {
      const role = String(raw.role || "").trim().toLowerCase();
      if (!KNOWN_ROLES.has(role)) continue;
      acts.push({ type, role });
      continue;
    }
    if (type === SPEECH_ACT_TYPES.SEER_RESULT) {
      const targetSeat = seat(raw.targetSeat);
      const result = faction(raw.result);
      if (!targetSeat || !result) continue;
      acts.push({ type, targetSeat, result });
      continue;
    }
    if (type === SPEECH_ACT_TYPES.WITCH_ACTION_CLAIM) {
      const action = String(raw.action || "").trim().toLowerCase();
      const targetSeat = seat(raw.targetSeat);
      if (!["pass", "save", "poison"].includes(action)) continue;
      acts.push({ type, action, ...(targetSeat ? { targetSeat } : {}) });
      continue;
    }
    if (type === SPEECH_ACT_TYPES.REFERENCE_CLAIM) {
      const speakerSeat = seat(raw.speakerSeat);
      const targetSeat = seat(raw.targetSeat);
      const claimType = String(raw.claimType || "").trim().toUpperCase();
      const result = faction(raw.result);
      if (!speakerSeat || !targetSeat || claimType !== "SEER_RESULT" || !result) continue;
      acts.push({ type, speakerSeat, targetSeat, claimType, result });
      continue;
    }
    if (type === SPEECH_ACT_TYPES.SUSPICION) {
      const targetSeat = seat(raw.targetSeat);
      const result = faction(raw.result);
      const confidence = ["low", "medium", "high"].includes(String(raw.confidence || "").toLowerCase())
        ? String(raw.confidence).toLowerCase()
        : "medium";
      if (!targetSeat || !result) continue;
      acts.push({ type, targetSeat, result, confidence });
      continue;
    }
    if (type === SPEECH_ACT_TYPES.CHALLENGE) {
      const targetSeat = seat(raw.targetSeat);
      if (!targetSeat) continue;
      acts.push({ type, targetSeat });
    }
  }
  return acts;
}

export function validateSpeechActs(acts, {
  speakerRole = null,
  seerChecks = [],
  witchAction = null,
  witchTargetSeat = null
} = {}) {
  const normalized = normalizeSpeechActs(acts);
  const acceptedActs = [];
  const rejectedActs = [];
  const errors = [];
  const roleClaims = new Set(normalized.filter((act) => act.type === SPEECH_ACT_TYPES.ROLE_CLAIM).map((act) => act.role));
  const knownChecks = new Map((seerChecks || []).map((check) => [seat(check.targetSeat), faction(check.result)]));

  const reject = (act, reason) => {
    rejectedActs.push(act);
    errors.push(reason);
  };

  for (const act of normalized) {
    if (act.type === SPEECH_ACT_TYPES.ROLE_CLAIM) {
      if (act.role === speakerRole || speakerRole === "werewolf") acceptedActs.push(act);
      else reject(act, `${speakerRole || "未知角色"}不能发布${act.role}身份声明`);
      continue;
    }
    if (act.type === SPEECH_ACT_TYPES.SEER_RESULT) {
      if (!roleClaims.has("seer")) {
        reject(act, "发布查验结果时必须同时声明预言家身份");
        continue;
      }
      if (speakerRole === "werewolf") {
        acceptedActs.push(act);
        continue;
      }
      if (speakerRole !== "seer") {
        reject(act, `${speakerRole || "未知角色"}不能发布自己的查验结果`);
        continue;
      }
      if (!knownChecks.has(act.targetSeat) || knownChecks.get(act.targetSeat) !== act.result) {
        reject(act, `预言家的${act.targetSeat}号结构化查验与真实记录不一致`);
        continue;
      }
      acceptedActs.push(act);
      continue;
    }
    if (act.type === SPEECH_ACT_TYPES.WITCH_ACTION_CLAIM) {
      if (!roleClaims.has("witch")) {
        reject(act, "发布用药信息时必须同时声明女巫身份");
        continue;
      }
      if (speakerRole === "werewolf") {
        acceptedActs.push(act);
        continue;
      }
      const targetMatches = !act.targetSeat || !witchTargetSeat || act.targetSeat === Number(witchTargetSeat);
      if (speakerRole !== "witch" || act.action !== witchAction || !targetMatches) {
        reject(act, "女巫的结构化用药声明与自己的夜间记录不一致");
        continue;
      }
      acceptedActs.push(act);
      continue;
    }
    acceptedActs.push(act);
  }

  return { ok: errors.length === 0, acceptedActs, rejectedActs, errors, warnings: [] };
}

export function claimsFromSpeechActs(acts) {
  return normalizeSpeechActs(acts).filter((act) => [
    SPEECH_ACT_TYPES.ROLE_CLAIM,
    SPEECH_ACT_TYPES.SEER_RESULT,
    SPEECH_ACT_TYPES.WITCH_ACTION_CLAIM
  ].includes(act.type));
}

export function resolveSpeechDelivery({
  hardError = null,
  structuredErrors = [],
  missingStructuredRoleClaim = false,
  semanticWarnings = [],
  acceptedActs = []
} = {}) {
  if (hardError) return { reject: true, useFallback: false };
  const hasExplanatoryActs = normalizeSpeechActs(acceptedActs).some((act) => [
    SPEECH_ACT_TYPES.REFERENCE_CLAIM,
    SPEECH_ACT_TYPES.SUSPICION,
    SPEECH_ACT_TYPES.ACTION_ADVICE,
    SPEECH_ACT_TYPES.CHALLENGE,
    SPEECH_ACT_TYPES.ROLE_CLAIM,
    SPEECH_ACT_TYPES.SEER_RESULT,
    SPEECH_ACT_TYPES.WITCH_ACTION_CLAIM
  ].includes(act.type));
  const useFallback = (structuredErrors || []).length > 0
    || Boolean(missingStructuredRoleClaim)
    || ((semanticWarnings || []).length > 0 && !hasExplanatoryActs);
  return { reject: false, useFallback };
}
