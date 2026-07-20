# Night Watch：六人狼人杀 Demo

这是一个无依赖的本地 Demo，默认使用确定性 Bot，不填写 Key 也可以完整测试对局。

## 启动

```powershell
node server.mjs
```

打开 <http://127.0.0.1:4173>。

也可以使用：

```powershell
npm run dev
```

## 规则

- 6 人：2 狼、2 平民、1 预言家、1 女巫。
- 每局使用 seed 独立随机座位，人类玩家不固定在 1 号位；固定身份只固定角色，不固定座位。
- 普通玩家视图、公开记录和 AI 上下文只使用座位号；姓名只在开发者审计中显示。
- 狼人胜利：平民全部出局，或预言家和女巫全部出局。
- 好人胜利：2 名狼人全部出局。
- 第一次平票进入并列玩家决战台发言后重投，第二次平票无人出局。
- 白天投票出局者拥有一次公开遗言，夜间死亡者没有遗言。
- 每名存活玩家可以弃票，弃票不计入候选票数。
- 女巫同一夜最多使用一瓶药。
- 狼人夜刀可以选择任意存活座位，包括自刀骗女巫解药；狼人也可以在白天投票开始前自爆，公开身份并跳过投票。
- 狼人夜间会共享私有提案和队长分工；狼队信息不会进入公开桌面记录。
- 首个未发言的 AI 狼人在首日承担悍跳任务；桌面已有公开预言家查杀时优先反跳对冲，悍跳发言会记录为狼队欺骗策略。
- 开局可填写复现种子；对局中可以导出或导入包含身份、公开事件、AI 决策记录和查验声明的 JSON 回放。

## 配置线上模型

点击右上角的模型设置，填写：

- 协议：`OpenAI-compatible` 或 `Anthropic-compatible`
- Base URL
- Endpoint Path
- Model
- API Key

配置和 API Key 会以明文写入当前浏览器的 `localStorage`，刷新页面后自动回填，不写入项目文件。设置页可一键清除本地配置。该方式仅适合本机 Demo，不应在共享电脑或正式 Web 部署中使用。线上请求失败时会自动回退到 Bot。

线上模型输出解析失败或动作校验失败时，客户端会带着校验错误重试一次，仍失败则回退到确定性 Bot。`deepseek-v4-flash` 会消耗输出预算进行推理，因此应用默认使用 `reasoning_effort=low`，并为发言和动作分别预留更大的 `max_tokens`，避免只返回 `reasoning_content` 而没有最终答案。设置页的“测试连接”会验证最终答案是否能经代理返回；对局页底部和开发者审计会显示实际调用、成功和回退数量。每名 AI 在单局内维护独立的公开事件、私密事件、声明、怀疑证据和轮次摘要；声明还会生成替代解释、动机受益关系和最多一层、按轮次过期的二阶假设。`AgentContext` 会按角色过滤私密频道：狼队只能读取 `wolf-room`，预言家只能读取 `seer-check`，女巫只能读取 `witch-night`，平民不读取这些频道。决策先由 `StrategyPlanner` 冻结合法动作和披露元数据，再由 `SpeechGenerator` 绑定公开文本；发言层不能改写目标、动作或读取真值。公开发言会记录内部沟通意图、披露模式、压力等级和预期反应；开发者模式可查看这些认知快照，普通视角不会显示。

公开发言提交前会将玩家姓名和内部 `PlayerId` 规范化为座位号，并拒绝超长文本或未经引擎确认的脚步声、狗叫、呼吸声等感官信息；线上模型会在校验失败后重试一次。

## 开发者模式

- 开局前可启用，也可以在对局中随时切换。
- 桌面座位会显示全部真实身份。
- 开发者面板会记录 AI 的发言、夜间技能、投票结果、来源和简短决策依据。
- 开发者面板可以运行固定种子 Bot 模拟，并显示完成数、失败数、首个不变量错误、胜负分布、平均天数、AI 动作数和模型重试数；可通过 URL 参数 `simulationCount`、`simulationSeed` 缩小定点复现范围。
- 开发者面板会显示规则不变量检查结果，包括座位/角色数量、事件顺序、公开发言边界和 AgentMemory 私密频道权限。
- 回放模式支持按公开事件上一步/下一步查看；导入文件会校验版本、角色数量、事件顺序和公开发言信息边界。
- 决策依据是模型显式返回的 `reasoningSummary` 或 Bot 的策略说明，不是模型隐藏思维链。
- 本地 Bot 的预言家会在白天公开身份和全部查验；好人会优先处理公开查杀，狼人会针对公开预言家调整行动。

OpenAI-compatible 默认路径：

```text
/chat/completions
```

Anthropic-compatible 默认路径：

```text
/v1/messages
```

## 文件说明

- `server.mjs`：静态文件服务和模型 API 代理。
- `server.mjs`：静态文件服务、完整 JSON 模型代理和发言 SSE 流式代理。
- `server/provider.mjs`：OpenAI-compatible / Anthropic-compatible 请求构造与响应归一化。
- `public/ai-core.js`：AgentMemory 和 ClaimGraph 的纯数据层。
- `public/ai-strategy.js`：策略计划冻结、发言绑定和策略审计快照。
- `public/ai-speech.js`：基于公开事件、发言轮次和角色人格生成差异化 Bot 发言，并拦截重复表达。
- `public/ai-situation.js`：基于合法后继状态的局势评估和终局分支模拟。
- `public/ai-disclosure.js`：角色受权的披露模式规划，不保存私密事实值。
- `public/ai-deception.js`：狼人欺骗账本、冲突检测、止损状态和不可变历史。
- `server/jsonl.mjs`：稳定 StoredEvent 的 JSONL 追加与读取。
- `test/fixtures/replay-sample.json`：回放导入的最小合法样例。
- `public/app.js`：6 人屠边规则状态机、Bot 和 UI 交互。
- `public/index.html`：页面结构。
- `public/styles.css`：响应式桌面/移动端样式。
- `test/`：Provider contract test 和 AI 认知层单元测试。

运行测试：

```powershell
npm test
```

当前版本是 Demo：发言请求已通过本地代理使用 OpenAI-compatible / Anthropic-compatible SSE，并在完整 JSON 校验后才进入事件日志；公开事件会由本地代理追加到 `server/data/<gameId>.jsonl`，回放仍支持浏览器 JSON 导入导出。
