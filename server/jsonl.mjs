import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export function createStoredEvent({ sequence, gameId, type, visibility = "PUBLIC", audience, payload, timestamp = new Date().toISOString() } = {}) {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("StoredEvent sequence 必须为正整数");
  if (!gameId || !type) throw new Error("StoredEvent 缺少 gameId 或 type");
  if (!["PUBLIC", "PRIVATE", "DEBUG"].includes(visibility)) throw new Error("StoredEvent visibility 不合法");
  return { sequence, gameId: String(gameId), timestamp, type: String(type), visibility, ...(audience ? { audience } : {}), payload: payload ?? null };
}

export async function appendStoredEvent(filePath, event) {
  const stored = createStoredEvent(event);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(stored)}\n`, "utf8");
  return stored;
}

export async function readStoredEvents(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return createStoredEvent(JSON.parse(line)); }
    catch (error) { throw new Error(`JSONL 第${index + 1}行无效：${error.message}`); }
  });
}
