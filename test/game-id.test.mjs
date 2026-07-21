import test from "node:test";
import assert from "node:assert/strict";
import { createGameId } from "../public/game-id.js";

test("same replay seed can create independent game ids", () => {
  assert.equal(createGameId(123, "first"), "g_123_first");
  assert.equal(createGameId(123, "second"), "g_123_second");
  assert.notEqual(createGameId(123, "first"), createGameId(123, "second"));
});

test("game ids remain safe for event-store file names", () => {
  assert.match(createGameId(42, "unsafe/value"), /^[A-Za-z0-9_-]{1,80}$/);
});
