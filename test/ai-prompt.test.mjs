import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActionPolicy,
  buildDecisionPrompt,
  buildRolePolicy,
  disclosureModesForRole,
  isDisclosureModeAllowed
} from "../public/ai-prompt.js";

test("role policies separate information and strategic responsibilities", () => {
  assert.match(buildRolePolicy("werewolf"), /狼队友|狼队私聊|bluff/);
  assert.match(buildRolePolicy("seer"), /查验|部分公开|暂时隐藏/);
  assert.match(buildRolePolicy("witch"), /解药|毒药|私人声明/);
  assert.match(buildRolePolicy("villager"), /没有夜间私密信息|不得冒充/);
});

test("only werewolves can request bluff disclosure", () => {
  assert.equal(isDisclosureModeAllowed("werewolf", "bluff"), true);
  assert.equal(isDisclosureModeAllowed("seer", "bluff"), false);
  assert.equal(isDisclosureModeAllowed("witch", "bluff"), false);
  assert.equal(isDisclosureModeAllowed("villager", "bluff"), false);
  assert.deepEqual(disclosureModesForRole("villager"), ["withhold"]);
});

test("action policies name the concrete task instead of relying on phase inference", () => {
  assert.match(buildActionPolicy({ kind: "seer", role: "seer" }), /预言家查验|选择一名玩家/);
  assert.match(buildActionPolicy({ kind: "witch", role: "witch", witchTargetLabel: "3号" }), /女巫用药|3号|pass、save、poison/);
  assert.match(buildActionPolicy({ kind: "wolf", role: "werewolf" }), /狼人夜间提案|自刀.*不是默认偏好/);
  assert.match(buildActionPolicy({ kind: "vote", role: "villager" }), /放逐投票|ABSTAIN/);
});

test("speech contracts expose only role-authorized actions and disclosure modes", () => {
  const wolf = buildDecisionPrompt({ common: "公共上下文", role: "werewolf", kind: "speech", canExplode: true });
  const villager = buildDecisionPrompt({ common: "公共上下文", role: "villager", kind: "speech", canExplode: false });
  assert.match(wolf, /speak、explode/);
  assert.match(wolf, /bluff/);
  assert.doesNotMatch(villager, /speak、explode/);
  assert.doesNotMatch(villager, /bluff/);
  assert.match(villager, /不得冒充预言家或女巫/);
  assert.match(villager, /speechActs/);
  assert.match(villager, /ACTION_ADVICE/);
  assert.match(villager, /REFERENCE_CLAIM/);
});
