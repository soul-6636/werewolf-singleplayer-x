import test from "node:test";
import assert from "node:assert/strict";
import { canExposeActiveActor, isNightPhase, publicWaitingText, visiblePhaseForPlayer } from "../public/view-visibility.js";

test("night phases are treated as private-action phases", () => {
  assert.equal(isNightPhase("night_wolf"), true);
  assert.equal(isNightPhase("night_witch"), true);
  assert.equal(isNightPhase("night_seer"), true);
  assert.equal(isNightPhase("discussion"), false);
});

test("normal players cannot see the active night actor", () => {
  assert.equal(canExposeActiveActor({ phase: "night_wolf", activePlayerId: "P6" }), false);
  assert.equal(publicWaitingText({ phase: "night_wolf", activePlayerLabel: "6 号" }), "夜间行动进行中");
});

test("AI phase context is limited to the role's own night action", () => {
  assert.equal(visiblePhaseForPlayer("night_wolf", "villager"), "night");
  assert.equal(visiblePhaseForPlayer("night_wolf", "werewolf"), "night_wolf");
  assert.equal(visiblePhaseForPlayer("night_witch", "seer"), "night");
  assert.equal(visiblePhaseForPlayer("discussion", "villager"), "discussion");
});

test("developer mode and daytime turns retain actor visibility", () => {
  assert.equal(canExposeActiveActor({ phase: "night_wolf", debugMode: true, activePlayerId: "P6" }), true);
  assert.equal(canExposeActiveActor({ phase: "discussion", activePlayerId: "P6" }), true);
  assert.equal(publicWaitingText({ phase: "discussion", activePlayerLabel: "6 号" }), "6 号正在行动");
});
