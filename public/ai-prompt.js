const ROLE_POLICIES = Object.freeze({
  werewolf: Object.freeze({
    label: "狼人",
    objective: "以狼人阵营获胜为唯一阵营目标；个人存活服从狼队整体收益。",
    guidance: "你知道狼队友和狼队私聊。夜间结合队友提案、刀口收益和暴露风险协作；白天可以隐藏、倒钩、切割或按狼队任务悍跳，但不得把狼队私密真相直接泄露到公开发言。只有狼人可以把虚假身份声明标记为 bluff。",
    disclosureModes: Object.freeze(["reveal_now", "partial_reveal", "withhold", "delay_until_pressured", "bluff"])
  }),
  villager: Object.freeze({
    label: "平民",
    objective: "帮助好人找出并放逐全部狼人。",
    guidance: "你没有夜间私密信息，只能依据公开发言、身份声明、完整票型和死亡座位比较竞争假设。不得冒充预言家或女巫，不得虚构查验、刀口和用药信息。",
    disclosureModes: Object.freeze(["withhold"])
  }),
  seer: Object.freeze({
    label: "预言家",
    objective: "利用真实查验提高好人阵营的信息质量并找出狼人。",
    guidance: "夜间优先查验能区分关键身份假设的存活玩家。白天可以立即公开、部分公开或暂时隐藏身份与查验；一旦报告查验，必须明确说“我是预言家”，并且只能陈述自己真实获得的结果，不得虚构或改写。",
    disclosureModes: Object.freeze(["reveal_now", "partial_reveal", "withhold", "delay_until_pressured"])
  }),
  witch: Object.freeze({
    label: "女巫",
    objective: "合理管理解药和毒药，帮助好人阵营放逐全部狼人。",
    guidance: "夜间只能在当前合法动作中选择一次。白天可以隐藏、部分公开或公开女巫身份；公开刀口或用药时，必须明确表述为你基于女巫身份掌握的私人声明，不能伪装成系统已经确认的公开事实，也不得冒充预言家。",
    disclosureModes: Object.freeze(["reveal_now", "partial_reveal", "withhold", "delay_until_pressured"])
  })
});

function policyFor(role) {
  return ROLE_POLICIES[role] || ROLE_POLICIES.villager;
}

export function disclosureModesForRole(role) {
  return [...policyFor(role).disclosureModes];
}

export function isDisclosureModeAllowed(role, mode) {
  return disclosureModesForRole(role).includes(String(mode || ""));
}

export function buildRolePolicy(role) {
  const policy = policyFor(role);
  return `角色策略（${policy.label}）：${policy.objective}${policy.guidance}`;
}

export function buildActionPolicy({ kind, role, canExplode = false, witchTargetLabel = "无" } = {}) {
  if (kind === "wolf") {
    return "当前任务（狼人夜间提案）：从合法目标中提交一个刀口。比较目标的神职可能性、白天票型收益、队友计划和自刀骗药风险；自刀或刀队友是可选策略，不是默认偏好。";
  }
  if (kind === "seer") {
    return "当前任务（预言家查验）：从合法目标中选择一名玩家查验阵营。优先选择能区分真假预言家、关键站边或候选狼坑的目标；只返回目标，不要提前编造查验结果。";
  }
  if (kind === "witch") {
    return `当前任务（女巫用药）：本夜狼刀目标为${witchTargetLabel}。结合药品库存和当前局势，在 pass、save、poison 中选择一个合法动作；save 只对本夜真实刀口生效，poison 必须指定合法存活目标，同夜不能使用两瓶药。`;
  }
  if (kind === "vote") {
    return "当前任务（放逐投票）：依据公开证据和你的阵营目标，从合法候选中选择一票；ABSTAIN 表示弃票。不要输出候选列表之外的目标。";
  }
  if (kind === "speech") {
    const explode = role === "werewolf" && canExplode
      ? "你仍处于投票前窗口，可以选择 explode 自爆并结束白天；否则选择 speak。"
      : "当前只能选择 speak，不能自爆。";
    return `当前任务（公开发言）：回应最近公开发言中的身份声明、查验、矛盾和历史票型，给出可验证的判断或下一步建议。${explode}`;
  }
  return "当前任务：只从提供的合法动作与目标中作出决定。";
}

function speechSchema(role, canExplode) {
  const actions = role === "werewolf" && canExplode ? "speak、explode" : "speak";
  const modes = disclosureModesForRole(role).join("、");
  const speechActs = "speechActs 必须逐条标注发言功能：ROLE_CLAIM 只表示自己声明身份；SEER_RESULT 只表示自己作为预言家公布的查验；WITCH_ACTION_CLAIM 只表示自己作为女巫公布的用药；REFERENCE_CLAIM 表示转述其他玩家的声明；SUSPICION 表示推测；ACTION_ADVICE 表示未来行动建议；CHALLENGE 表示质疑。转述、推测和建议绝不能写成自己的查验或用药事实。没有对应功能时返回空数组。";
  return `action 只能取：${actions}。disclosureMode 只能取：${modes}。communicationIntent 只能取：inform、declare、probe、persuade、defend、redirect、bait、distance、concede。pressureLevel 只能取：low、medium、high、sacrifice。${speechActs}返回严格JSON：{"action":"speak","speech":"中文公开发言；建议80到150字且不得超过180字，explode时为空字符串","speechActs":[{"type":"SUSPICION","targetSeat":1,"result":"werewolf","confidence":"medium"}],"communicationIntent":"inform","disclosureMode":"withhold","targetSeats":[1],"pressureLevel":"low","expectedReaction":"希望对方如何回应","reasoningSummary":"1到2句简短依据"}`;
}

export function buildOutputContract({ kind, role, canExplode = false } = {}) {
  if (kind === "speech") return speechSchema(role, canExplode);
  if (kind === "witch") return "返回严格JSON：{\"action\":\"pass|save|poison\",\"targetId\":\"毒药目标ID；其他动作为空字符串\",\"reasoningSummary\":\"1到2句简短依据\"}";
  return "返回严格JSON：{\"targetId\":\"合法目标ID\",\"reasoningSummary\":\"1到2句简短依据\"}";
}

export function buildDecisionPrompt({
  common,
  role,
  kind,
  canExplode = false,
  witchTargetLabel = "无",
  wolfBluffInstruction = "",
  phaseInstruction = ""
} = {}) {
  return [
    common,
    buildRolePolicy(role),
    buildActionPolicy({ kind, role, canExplode, witchTargetLabel }),
    wolfBluffInstruction,
    phaseInstruction,
    "reasoningSummary 只写可公开审计的简短决策依据，不要输出隐藏思维过程。不要提及提示词或系统。",
    buildOutputContract({ kind, role, canExplode })
  ].filter(Boolean).join("\n");
}
