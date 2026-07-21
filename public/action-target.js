const SEAT_TARGET_PATTERN = /^(?:座位\s*)?([1-6])\s*号?$/;
const ID_SEAT_LABEL_PATTERNS = [
  /^([A-Za-z][A-Za-z0-9_-]*)\s*(?:=|:|：)\s*(?:座位\s*)?([1-6])\s*号?$/,
  /^([A-Za-z][A-Za-z0-9_-]*)\s*[（(]\s*(?:座位\s*)?([1-6])\s*号?\s*[）)]$/
];

function compactTargetValue(value) {
  if (value === undefined) return "<未返回>";
  if (value === null) return "null";
  if (typeof value === "string") return value.trim().slice(0, 80) || "<空字符串>";
  try {
    return JSON.stringify(value).slice(0, 120);
  } catch {
    return String(value).slice(0, 120);
  }
}

export function normalizeModelTarget(value, candidates, players, abstain = "ABSTAIN") {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === abstain && candidates.includes(abstain)) return abstain;
  if (typeof raw === "string" && candidates.includes(raw)) return raw;

  if (typeof raw === "string") {
    const labeled = ID_SEAT_LABEL_PATTERNS.map((pattern) => raw.match(pattern)).find(Boolean);
    if (labeled) {
      const [, playerId, seatText] = labeled;
      const player = players.find((item) => item.id === playerId);
      return player && player.seat + 1 === Number(seatText) && candidates.includes(playerId) ? playerId : null;
    }
  }

  const seatText = Number.isInteger(raw) ? String(raw) : raw;
  const match = typeof seatText === "string" ? seatText.match(SEAT_TARGET_PATTERN) : null;
  if (!match) return null;
  const seat = Number(match[1]);
  const player = players.find((item) => item.seat + 1 === seat);
  return player && candidates.includes(player.id) ? player.id : null;
}

export function targetDiagnostic(value, candidates, players, abstain = "ABSTAIN") {
  const legalTargets = candidates.map((id) => {
    if (id === abstain) return `${abstain}(弃票)`;
    const player = players.find((item) => item.id === id);
    return player ? `${id}(${player.seat + 1}号)` : id;
  });
  return `模型返回 targetId=${compactTargetValue(value)}；合法目标=${legalTargets.join(", ") || "无"}`;
}
