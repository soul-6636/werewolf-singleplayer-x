const MAX_SPEECH_CHARS = 180;

function seatLabel(seat) {
  return `${Number(seat) || 0}号`;
}

function normalize(value) {
  return String(value || "")
    .replace(/[\s，。！？、：；“”‘’（）()《》]/g, "")
    .trim();
}

function excerpt(value, limit = 28) {
  const text = String(value || "")
    .replace(/[\r\n]+/g, "")
    .replace(/[“”"'‘’]/g, "")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function aliveCandidateSeats({ aliveSeats = [], selfSeat, recentSpeeches = [], turn = 0 } = {}) {
  const spokenSeats = recentSpeeches
    .map((event) => Number(event.speakerSeat || event.seat || 0))
    .filter(Boolean);
  const candidates = [...new Set([...spokenSeats, ...aliveSeats.map(Number)])]
    .filter((seat) => seat && seat !== Number(selfSeat) && aliveSeats.map(Number).includes(seat));
  return candidates.length ? candidates : aliveSeats.map(Number).filter((seat) => seat !== Number(selfSeat));
}

function chooseFocus({ aliveSeats, selfSeat, recentSpeeches, publicClaims, turn }) {
  const wolfClaim = publicClaims
    .flatMap((claim) => (claim.checks || []).map((check) => ({ ...check, speakerSeat: claim.speakerSeat })))
    .find((check) => check.faction === "werewolf" && Number(check.targetSeat));
  if (wolfClaim) return { seat: Number(wolfClaim.targetSeat), claim: wolfClaim };
  const candidates = aliveCandidateSeats({ aliveSeats, selfSeat, recentSpeeches, turn });
  const seat = candidates[(Number(turn) + Number(selfSeat || 0)) % candidates.length] || candidates[0] || null;
  return { seat, claim: null };
}

function latestPublicResult(recentEvents = []) {
  return [...recentEvents].reverse().find((event) => event.kind === "death" || event.kind === "night") || null;
}

function buildFocusText(focusSeat, recentSpeeches) {
  const event = [...recentSpeeches].reverse().find((item) => Number(item.speakerSeat || item.seat) === Number(focusSeat));
  if (!event) return `${seatLabel(focusSeat)}还没有给出具体判断`;
  return `${seatLabel(focusSeat)}上一轮提到“${excerpt(event.text, 22)}”`;
}

function chooseVariant({ persona, turn }) {
  const offset = ["谨慎克制", "逻辑直接", "擅长观察", "容易怀疑", "温和但坚定"].indexOf(persona);
  return (Math.max(0, offset) + Number(turn || 0)) % 3;
}

function buildSpeech({ role, selfSeat, persona, day, turn, focus, focusText, publicResult, publicClaims }) {
  const focusLabel = seatLabel(focus.seat);
  const resultPhrase = publicResult?.text ? `“${excerpt(publicResult.text, 24)}”` : "昨夜没有可直接定性的公开结果";
  const latestClaim = publicClaims[publicClaims.length - 1];
  const hasClaim = Boolean(latestClaim);
  const claimText = latestClaim
    ? `${seatLabel(latestClaim.speakerSeat)}刚报出${(latestClaim.checks || []).map((check) => `${seatLabel(check.targetSeat)}${check.faction === "werewolf" ? "查杀" : "好人结果"}`).join("、") || "公开查验"}`
    : "桌面暂时没有公开查验";
  const claimLead = hasClaim ? `目前${claimText}，但信息还不完整。` : "目前没有公开查验，信息还不完整。";
  const claimCaution = hasClaim ? `${claimText}只是线索，不能替代发言和投票` : "目前没有公开查验，不能替代发言和投票";
  const variant = chooseVariant({ persona, turn });

  if (role === "werewolf") {
    const lines = [
      `我先点${focusLabel}。${focusText}，但还没有把判断落到具体票型上。今天请${focusLabel}明确最想投谁，别只复述桌面结论。`,
      `我不把${resultPhrase}直接当成身份结论。${focusText}，我更想听${focusLabel}解释自己的站边和归票依据。`,
      `今天先看${focusLabel}的前后是否一致。${claimCaution}；请大家分别报出狼坑。`
    ];
    return { speech: lines[variant], reasoningSummary: `围绕${focusLabel}的公开发言和票型要求具体解释，避免直接跟随单一结论。` };
  }

  if (role === "witch") {
    const lines = [
      `我不把${resultPhrase}直接等同于身份。${focusText}，请${focusLabel}补充今天的怀疑对象和归票理由，我会把夜间结果与白天行为分开看。`,
      `${claimLead}${focusText}，先解释你为什么站这个位置，再看谁在借模糊结论组织票型。`,
      `我今天关注${focusLabel}：${focusText}。不是一句话就定狼，重点核对他的判断、站边和最后投票是否一致。`
    ];
    return { speech: lines[variant], reasoningSummary: `把公开夜间结果与${focusLabel}的白天行为分开核对，不直接锁定身份。` };
  }

  const lines = [
    `我没有夜间信息。${focusText}，但还没有说明最想投谁；我先要求${focusLabel}给出明确狼坑，再根据后面的票型修正判断。`,
    `我先关注${focusLabel}，因为${focusText}。我不跟着情绪定身份，请${focusLabel}补充具体目标，其他人也要独立报票。`,
    `${claimText}。我没有私密信息，所以只核对${focusLabel}的发言、站边和投票是否一致，不把“说得像”当成好人证据。`
  ];
  return { speech: lines[variant], reasoningSummary: `基于公开发言和票型聚焦${focusLabel}，明确区分事实、判断和待验证假设。` };
}

export function speechFingerprint(text) {
  return normalize(text).slice(0, MAX_SPEECH_CHARS);
}

export function generateContextualBotSpeech({
  role = "villager",
  selfSeat,
  persona = "",
  day = 1,
  turn = 0,
  aliveSeats = [],
  recentEvents = [],
  publicClaims = [],
  previousSpeeches = []
} = {}) {
  const recentSpeeches = recentEvents.filter((event) => event.kind === "speech");
  const focus = chooseFocus({ aliveSeats, selfSeat, recentSpeeches, publicClaims, turn });
  const result = buildSpeech({
    role,
    selfSeat,
    persona,
    day,
    turn,
    focus,
    focusText: buildFocusText(focus.seat, recentSpeeches),
    publicResult: latestPublicResult(recentEvents),
    publicClaims
  });
  let speech = result.speech.slice(0, MAX_SPEECH_CHARS);
  if (previousSpeeches.some((item) => speechFingerprint(item) === speechFingerprint(speech))) {
    speech = `${speech.slice(0, MAX_SPEECH_CHARS - 20)}我会保留这个判断，等票型验证。`;
  }
  return {
    speech,
    reasoningSummary: result.reasoningSummary,
    communicationIntent: "persuade",
    disclosureMode: "withhold",
    targetSeats: focus.seat ? [focus.seat] : [],
    pressureLevel: Number(turn) > 2 ? "medium" : "low"
  };
}

export function generateLastWordsSpeech({ selfSeat, role = "villager", seerClaim = null } = {}) {
  if (role === "seer" && seerClaim?.checks?.length) {
    const checks = seerClaim.checks.map((check) => `${seatLabel(check.targetSeat)}${check.faction === "werewolf" ? "是狼人" : "是好人"}`).join("，");
    return {
      speech: `我这轮已经被放逐，遗言补充：我是预言家，查验结果是${checks}。请大家按这组公开信息和刚才的票型继续核对，不要把我的出局当成新的查验结果。`,
      reasoningSummary: "遗言先确认出局状态，再补充预言家查验，避免继续以存活玩家身份参与讨论。"
    };
  }
  const lines = [
    "我这轮已经被放逐，遗言不改变票型。请回看刚才的发言和投票，重点核对谁在缺少查验依据时推动归票。",
    "我已经出局，只留下一个提醒：不要把我的放逐本身当成查验结果，下一轮继续对照每个人前后发言和投票是否一致。",
    "我已经出局，这是我的遗言，我不会再参与后续讨论。请把刚才的票型和站边放在一起复盘，优先验证最坚决推动放逐的人。"
  ];
  return {
    speech: lines[Number(selfSeat || 0) % lines.length],
    reasoningSummary: "遗言明确确认出局状态，只复盘已公开的发言和票型，不新增存活玩家式追问。"
  };
}
