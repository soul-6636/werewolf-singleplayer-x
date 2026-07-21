function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesWolfBluffReport(speech, { targetSeat, result } = {}) {
  const seat = Number(targetSeat);
  if (!Number.isInteger(seat) || seat < 1 || seat > 6 || !result) return false;
  const pattern = new RegExp(`(?:^|[^0-9])${seat}\\s*号?[^。！？\\n]{0,16}${escapeRegExp(result)}`);
  return pattern.test(String(speech || ""));
}
