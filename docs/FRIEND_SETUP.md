# 朋友安装与验收指南（Windows / Edge）

这是**本地实验项目**，不是微信网页版替代品，也不是第三方代管微信账号。需要你自己登录、配对并确认每个真实发送阶段。

## 0. 开始前

- Windows 10/11、Node.js >=22.13、npm、Microsoft Edge。
- 你自己的 ChatGPT 网页账号，以及你有权使用的微信 iLink Bot 登录资格。
- 建议使用**专门测试的 ChatGPT 对话**和不涉及隐私的测试消息。
- 不同账号可能无法完成微信机器人配对，若 QR 失败或提示不可用，请停下来，不要频繁重试或绕过验证。
- 本项目只允许**一个配对后的私聊发送者**；群聊、多账号和普通个人聊天总览不是此项目目标。

## 1. 本地安装（不会联网到微信）

下载或克隆仓库后，在项目目录打开 PowerShell：

```powershell
npm ci
npm test
npm run check
npm run demo
```

`npm ci` 需要连接 npm 下载依赖；**其余三项均使用假消息／本地测试**。

## 2. 手动准备 ChatGPT 页面

1. 在 Edge 打开 `chatgpt.com`，登录**自己的**账号，新开一个干净对话。
2. 在项目目录运行 `node scripts/start-web-host.mjs`，保持终端打开。本地 Host 监听 `127.0.0.1:8799`，自动创建只存本机的密钥。
3. Edge 访问 `edge://extensions`，打开开发人员模式，点「加载解压缩的扩展」，选择本项目的 `web-extension` 目录。你也可以运行 `Prepare Edge Extension (Manual).cmd` 让它引导你手动选择。
4. 在项目根目录运行 `Copy Web Bridge Key.cmd`，复制本机 `data/web-host.key` 的值，只粘贴进**你亲自安装**的扩展弹窗，点击保存。
5. 切回打算用于聊天的 ChatGPT 标签页，点击扩展「绑定当前标签页」，然后「启动网页接收」。确认扩展状态及 `http://127.0.0.1:8799/health` 的 Host 状态为 `HOST_READY`。
6. **聊天窗口变更前**，先在扩展里停止旧监听并确认当前任务结束，再重新绑定新的对话。关闭标签页不等于后台自动停止。

不要把 `web-host.key`、二维码或私聊内容发给任何人。

## 3. 微信机器人身份登录与配对（第一次真实微信操作）

先阅读 README 的风险说明。明确愿意使用这个登录途径，才运行：

```powershell
npm run weixin -- login
```

终端显示二维码和确认提示；使用你有权限的客户端扫码。完成后，再运行：

```powershell
npm run weixin -- pair
```

它会让你手动在目标 Bot 私聊里发送一段**随机一次性挑战文本**，只允许一名精确匹配者成为绑定对象。登录令牌本地加密保存；`data/` 已被 Git 忽略。

如果命令要求权限确认、账号资格、验证码、明确批准，不要跳过。配对完成后先检查本地状态，不要立即开启多分钟自动聊天。

## 4. 单次验收，然后才尝试短时聊天

配对成功、扩展已绑定、Host 显示就绪后，建议先用两段式测试：

- `Weixin Web One-Shot 1 Receive.cmd`：先在终端输入 `POLL WEIXIN ONCE` 授权启动唯一的 90 秒受控接收窗口。**不要提前发挑战码**；必须等终端明确打印 `WEIXIN_LISTENER_ARMED` 后，再把随后显示的全新挑战码发送到已配对微信 Bot 私聊。若服务器在你发送前明确返回 `server_empty`，脚本只会在本次已授权窗口内安全重挂下一次监听；`client_timeout`、协议错误或不确定状态仍立即停止。该阶段只接收并等待 ChatGPT 回复，**不会向微信回发**。
- One-Shot 会把服务端完整响应区分为 `server_messages` / `server_empty` / `client_timeout` / `error`，并记录耗时、HTTP 状态、ret/errcode 与 cursor 元数据；不再把客户端超时冒充成空消息。
- 核对回复确实属于目标会话后，运行 `Weixin Web One-Shot 2 Send Approved.cmd`，按提示手工确认**恰好一次**微信发送。
- 请在手机上实际看到回复，再把它当作成功。超时或状态不明时**禁止再点一次**，先查看只读状态：`Check Weixin Bridge Status.cmd`。

两段式单次验收通过后，才可以研究 `Start Weixin Web Chat 30min.cmd`。它会要求你在微信发送新的启动标记、再在本机输入确认词；最多 30 分钟、20 条新消息。**旧消息可能被记录为不自动回复的历史积压**，务必阅读终端提示。

请勿同时启动多个微信轮询器、多个聊天会话或多个 One-Shot。

## 5. 图片功能现在如何使用？

图片解密、持久化、HTTP 限权传输、网页附件预检都已有离线代码和测试。但是图片真正送进 ChatGPT、确认模型识别到图片、最后回微信的端到端路径**还没上线**。默认关闭，现阶段仅适合开发者看代码与运行测试。

## 6. 出问题怎么办？

如果微信已经登录并完成单人配对，但真实消息始终收不到，可以先双击根目录的 `Check Weixin Inbound Health.cmd`。它会执行一次 `notifyStart → getUpdates → notifyStop` 诊断读取，只输出统计状态；**不会修改 LetterFerry 本地持久化 cursor、不会打印聊天正文、不会向微信发送回复**。注意：iLink 服务端是否会把一次读取视为已消费、以及是否保证重放，不由 LetterFerry 控制，因此“本地未提交 cursor”不能被解释成“服务端绝对不会影响未处理消息”。

- `WEIXIN_INBOUND_AVAILABLE`：已配对私聊的入站流量可见，可以继续 one-shot 验收。
- `WEIXIN_NO_INBOUND_OBSERVED`：服务端完成了这一轮请求但没有返回入站消息。**这本身是不确定结果，不能单独证明上游阻塞**；正常空闲账号也可能返回 0 条。
- `WEIXIN_INBOUND_CLIENT_TIMEOUT`：客户端 45 秒截止时间先到，没有取得完整服务端响应；不能当成 `server_empty`。
- 本工作站当前文字链路已经完成一次真实端到端验收，状态为 `END_TO_END_ACCEPTED`；朋友或其他机器仍需各自执行 one-shot 验收。需要重新验证时，确认挑战码是在 `WEIXIN_LISTENER_ARMED` 之后发送，并使用空白、专用的 ChatGPT 测试对话。
- 需要向维护者说明现场时，可双击 `Generate Weixin Support Report.cmd`。它会在 `reports-local/weixin-support-report.json` 生成脱敏报告；该目录默认被 `.gitignore` 忽略。报告不包含聊天正文、token、context token、完整账号/配对 ID，也不会提交 cursor 或向微信发消息。
- 当前工作站的完整实机验收证据、可靠性边界与仍未覆盖的范围记录在 `docs/WEIXIN_E2E_ACCEPTANCE.md`，避免后续重复从头排查。
- `HOST_UNVERIFIED`：检查本地 Host 是否在运行、扩展是否绑定的是当前准确对话，以及扩展的密钥是否来自同一项目。
- `OUTBOUND_UNKNOWN`、`DELIVERY_UNKNOWN`：**暂停、人工复核，不要重试同一条**。
- 微信 QR 或账号被拒绝：停止、检查平台说明和授权资格，不尝试绕过限制。
- 图片没出现在 ChatGPT：当前版本本来就没有开放真实图片收发，不是朋友操作失误。

**隐私检查**：分享 GitHub 链接可以；不要分享本地 `data/`、任何浏览器 Profile、`*.key`、`*.token`、带密钥的 URL、账号截图。