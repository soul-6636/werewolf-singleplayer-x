import test from "node:test";
import assert from "node:assert/strict";
import { matchesWolfBluffReport } from "../public/wolf-bluff.js";

const task = { targetSeat: 2, result: "狼人" };

test("accepts normal Chinese seat formatting in a wolf bluff report", () => {
  assert.equal(matchesWolfBluffReport("我是预言家，2号是狼人。", task), true);
  assert.equal(matchesWolfBluffReport("我是预言家，2 号查验结果为狼人。", task), true);
  assert.equal(matchesWolfBluffReport("我验了2号，结果是狼人。", task), true);
});

test("rejects the wrong seat and multi-digit seat lookalikes", () => {
  assert.equal(matchesWolfBluffReport("我是预言家，3号是狼人。", task), false);
  assert.equal(matchesWolfBluffReport("我是预言家，12号是狼人。", task), false);
});
