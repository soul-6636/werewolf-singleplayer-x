const ACTIVE = "ACTIVE";
const STATUSES = new Set([ACTIVE, "CONFLICTED", "MITIGATED", "ABANDONED"]);

function limited(value, max) {
  return String(value || "").trim().slice(0, max);
}

export function createDeceptionLedger() {
  return { version: 1, nextId: 1, entries: [], history: [], conflicts: [] };
}

function snapshot(entry) {
  return Object.freeze(JSON.parse(JSON.stringify(entry)));
}

export function addDeception(ledger, deception = {}) {
  if (!ledger || !deception) return null;
  const entry = {
    id: `deception_${ledger.nextId++}`,
    day: Number(deception.day) || 0,
    type: limited(deception.type || "BLUFF", 24),
    sourceEventId: deception.sourceEventId || null,
    claimedRole: limited(deception.claimedRole, 32) || null,
    claimedResults: Array.isArray(deception.claimedResults) ? deception.claimedResults.slice(0, 4).map((item) => ({ ...item })) : [],
    publicTargetIds: Array.isArray(deception.publicTargetIds) ? deception.publicTargetIds.slice(0, 3) : [],
    commitments: Array.isArray(deception.commitments) ? deception.commitments.slice(0, 4).map((item) => limited(item, 100)) : [],
    fallback: limited(deception.fallback, 140),
    exposureRisk: limited(deception.exposureRisk, 140),
    stopLossAction: limited(deception.stopLossAction || deception.stopLoss, 140),
    status: ACTIVE
  };
  ledger.entries.unshift(entry);
  ledger.history.unshift({ type: "CREATED", entry: snapshot(entry) });
  if (ledger.entries.length > 12) ledger.entries.pop();
  if (ledger.history.length > 40) ledger.history.pop();
  return entry;
}

export function reconcileDeception(ledger, observation = {}) {
  if (!ledger) return [];
  const conflicts = [];
  for (const entry of ledger.entries) {
    if (entry.status !== ACTIVE) continue;
    const roleConflict = entry.claimedRole && observation.claimedRole && entry.claimedRole !== observation.claimedRole;
    const resultConflict = Array.isArray(observation.claimedResults) && entry.claimedResults.length && JSON.stringify(entry.claimedResults) !== JSON.stringify(observation.claimedResults);
    if (!roleConflict && !resultConflict) continue;
    entry.status = "CONFLICTED";
    const conflict = {
      id: `conflict_${ledger.conflicts.length + 1}`,
      day: Number(observation.day) || 0,
      entryId: entry.id,
      sourceEventId: observation.sourceEventId || null,
      reason: roleConflict ? "公开身份声明冲突" : "公开查验声明冲突"
    };
    ledger.conflicts.unshift(conflict);
    ledger.history.unshift({ type: "CONFLICT", entry: snapshot(entry), conflict: { ...conflict } });
    conflicts.push(conflict);
  }
  return conflicts;
}

export function updateDeceptionStatus(ledger, entryId, status, note = "") {
  if (!ledger || !STATUSES.has(status)) return null;
  const entry = ledger.entries.find((item) => item.id === entryId);
  if (!entry) return null;
  const previous = snapshot(entry);
  entry.status = status;
  ledger.history.unshift({ type: "STATUS", entry: previous, nextStatus: status, note: limited(note, 140) });
  if (ledger.history.length > 40) ledger.history.pop();
  return entry;
}

export function snapshotDeceptionLedger(ledger) {
  return JSON.parse(JSON.stringify(ledger || createDeceptionLedger()));
}
