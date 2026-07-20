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
- 狼人胜利：平民全部出局，或预言家和女巫全部出局。
- 好人胜利：2 名狼人全部出局。
- 第一次平票重投，第二次平票无人出局。
- 每名存活玩家可以弃票，弃票不计入候选票数。
- 女巫同一夜最多使用一瓶药。

## 配置线上模型

点击右上角的模型设置，填写：

- 协议：`OpenAI-compatible` 或 `Anthropic-compatible`
- Base URL
- Endpoint Path
- Model
- API Key

配置和 API Key 会以明文写入当前浏览器的 `localStorage`，刷新页面后自动回填，不写入项目文件。设置页可一键清除本地配置。该方式仅适合本机 Demo，不应在共享电脑或正式 Web 部署中使用。线上请求失败时会自动回退到 Bot。

## 开发者模式

- 开局前可启用，也可以在对局中随时切换。
- 桌面座位会显示全部真实身份。
- 开发者面板会记录 AI 的发言、夜间技能、投票结果、来源和简短决策依据。
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
- `public/app.js`：6 人屠边规则状态机、Bot 和 UI 交互。
- `public/index.html`：页面结构。
- `public/styles.css`：响应式桌面/移动端样式。

当前版本是 Demo：模型请求尚未做流式输出，正式版可以继续接入 SSE、事件存档和独立 TypeScript 规则包。
