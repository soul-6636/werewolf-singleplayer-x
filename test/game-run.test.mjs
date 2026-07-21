import test from "node:test";
import assert from "node:assert/strict";
import { createGameRunCoordinator, isStaleGameRunError } from "../public/game-run.js";

test("starting a new game aborts the previous run and rejects its late result", () => {
  const runs = createGameRunCoordinator();
  const first = runs.begin("game-1");
  const second = runs.begin("game-2");

  assert.equal(first.signal.aborted, true);
  assert.equal(runs.isCurrent(first), false);
  assert.equal(runs.isCurrent(second), true);
  assert.throws(
    () => runs.assertCurrent(first),
    (error) => isStaleGameRunError(error) && error.gameId === "game-1"
  );
});
