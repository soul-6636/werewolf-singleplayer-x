import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelTarget, targetDiagnostic } from "../public/action-target.js";

const players = [
  { id: "P1", seat: 0, alive: true },
  { id: "P6", seat: 5, alive: true }
];

test("normalizes model seat labels to internal player ids", () => {
  assert.equal(normalizeModelTarget("6", ["P1", "P6"], players), "P6");
  assert.equal(normalizeModelTarget(6, ["P1", "P6"], players), "P6");
  assert.equal(normalizeModelTarget("6号", ["P1", "P6"], players), "P6");
  assert.equal(normalizeModelTarget("6 号", ["P1", "P6"], players), "P6");
});

test("keeps legal player ids and rejects unknown targets", () => {
  assert.equal(normalizeModelTarget("P1", ["P1", "P6"], players), "P1");
  assert.equal(normalizeModelTarget("P999", ["P1", "P6"], players), null);
  assert.equal(normalizeModelTarget("1", ["P6"], players), null);
});

test("accepts a displayed id-seat label only when both parts identify the same legal player", () => {
  assert.equal(normalizeModelTarget("P6=6号", ["P1", "P6"], players), "P6");
  assert.equal(normalizeModelTarget("P6(6号)", ["P1", "P6"], players), "P6");
  assert.equal(normalizeModelTarget("P6=1号", ["P1", "P6"], players), null);
});

test("diagnostic contains only the target value and legal target list", () => {
  assert.equal(
    targetDiagnostic("P999", ["P1", "P6"], players),
    "模型返回 targetId=P999；合法目标=P1(1号), P6(6号)"
  );
});
