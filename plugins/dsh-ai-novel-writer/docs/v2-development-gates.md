# AI Novel Writer V2 开发门禁

本文件只记录本插件已经遇到的运行时陷阱和相应门禁。Harness 通用安装、固定上游基线与动态 Cordis Package 的说明仍由 [official-dsh-plugin-installation.md](official-dsh-plugin-installation.md) 负责；不要把同一套规则复制到多个地方。

## 官方接口依据（当前插件依赖的 DSH 0.1.0-rc.6）

以下是本插件接口决策的外部依据；它们定义 DSH 或 Playwright 的合同，不能用个人经验替代。浏览器脚本中的具体等待顺序则是本项目的资格策略，会在下文单独标明。

| 接口问题 | 已核对的官方依据 | 本插件据此遵守的边界 |
| --- | --- | --- |
| 扩展职责 | [Architecture reference](https://deepseek-harness.github.io/deepseek-harness/en/reference/)；[Core](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/core) | Host、agent preset 与 Client 分属不同扩展面；共享状态留在 Host，会话 persona 和工具留在 preset，页面留在 Client。 |
| Host/Client 传输 | [Typert](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/typert) | 跨端调用只传 lossless JSON DTO；不传 live Session、Workspace、Tool 或 React 对象。 |
| preset 发现与挂载 | [Config catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/config-catalog)；[Core](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/core) | 保持 `includeUserRoot: true`，以真实 roster 的 `list` 与安装字节的 `standingKeyFor` 验证用户 preset，而不覆盖系统 preset。 |
| 模型工具合同 | [Tools](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools)；[Adding a tool](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool) | 按当前可见 schema 的工具名集合验证；官方资料未承诺工具数组顺序，因此不得依赖装配顺序。 |
| 打包与隔离 profile | [Publish / install](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) | 从 bundle 安装到隔离 profile，并以实际 `--dump-config` 和 roster 证明加载。 |
| 浏览器重绘后的断言 | [Playwright locators](https://playwright.dev/docs/locators) | Proposal 后重新获取 locator、必要时重新展开 disclosure，是本项目基于 Locator 当前 DOM 解析方式采取的测试策略，**不是** DSH API 对 `<details>` 重绘的保证。 |

因此，若运行时行为与上述合同冲突，先收集实际 DTO、roster、挂载和工具 schema，再回到相应官方说明判断；不要以旧脚本或 UI 偶然时序推断接口含义。

## 先决定扩展面

先按官方 `cordis-plugin-development` 与 `editing-cordis-compositions` Skill 选择最接近数据所有者的面：

| 面 | 本插件职责 | 不要放入 |
| --- | --- | --- |
| Host | `NovelStore`、跨会话持久化、模型工具和 Host 生命周期 | Client 布局、会话专属 persona，或 live Session/Workspace/Tool 对象 |
| Agent preset | 单个会话的 persona 与模型工具装配 | 共享存储、Client UI、Host registry 或第二套服务 |
| Client | Slot 中的工作台、现有会话 prompt 与标准页面 props | 浏览器直写、模型工具注册，或已有 props 可提供的数据再经 Host 转发 |

只有 Client 确实缺少所需数据时才增加 Package-private `host.call`，其参数与返回值只含已提取的 lossless JSON 标量、数组和对象。本插件的 V2 创作链保持两个模型工具：`novel_read` 与 `novel_propose_change`。工具合同按集合验证，必须恰好包含这两个名字，不依赖 DSH 未承诺的装配顺序。模型结果进入非权威 Proposal inbox；浏览器通过既有会话 prompt 发起创作，人工审核再走现有命令通道。不要为生成、草稿或界面状态新增第二套 Host RPC、SQLite 库或后台工作流。

## 真实入口门禁

单测、构建和 tarball 只证明局部产物，不能证明 DSH Web profile 实际加载了该 preset。任何改动 preset、Host 挂载、Client 工作台、工具输入输出或 Proposal 流程时，按以下顺序推进；前一项没有证据就停在该项排查。

1. 跑相关回归、`typecheck` 和构建；模型或用户可见行为同时更新 keyless Loader → session → SQLite → `proposal/list` 回归。改动 preset composition 时，还要用 `standingKeyFor` 对已安装字节执行真实 mount 验证；roster 的 `broken` 字段只做格式检查，不能替代 mount。
2. 从构建出的 tarball 安装到隔离 `DSH_HOME` 的 Web profile，并读取该 profile 的实际 `--dump-config`。Windows 路径含空格时由资格脚本处理参数边界；不要把 shell 规避写成普通用户安装说明。
3. 通过插件配置卡把两个 bundled preset 安装到该隔离 home 的派生用户根，然后重启 Web。不要编辑或覆盖 DSH 随部署提供的系统 preset。`apps/cli` 的 profile boot 会在组合结束时固定系统 preset 根；覆盖层不要冒充或重写 `agent-presets.roots`。保持 `includeUserRoot: true`，让已安装的用户 preset 被 roster 发现。
4. 在任何菜单点击或工作台断言前，读取真实 `agentPreset.list` 响应并确认 `ai-novel-writer-v2` 出现在 roster。已打包的 `preset.yml` 可校验但不能替代这一步。
5. 用无密钥资格后端走实际浏览器链：选择 V2 → 打开工作台 → 安装/重启后的预设可见 → 初始化 → AI Proposal → 人工应用 → **同页刷新可见** → 重启读回。浏览器断言应检查用户可见的表单、阶段导航和持久状态，而不是原始 JSON 或内部 ID。Proposal 生命周期操作后，用 fresh/dynamic locator 重新定位审核 disclosure，必要时展开，并在当前已打开的 disclosure 内等待精确的用户可见状态；不要持有刷新前的元素引用，也不要依赖旧节点消失。浏览器重新加载页面只能证明持久化，不能代替同页状态刷新。
6. 若工具合同失败，先从持久 session 的 `request/header.tools` 记录真实名称，再决定修复 agent 面还是资格脚本；不得把不承诺的 DSH 工具顺序写进资格断言。

资格脚本与现有 README 的 release qualification 段是这条链路的唯一可执行入口。隔离 DSH 目录、日志和截图必须有 `.vibe-owner.json`、TTL 和精确清理范围；不把小说内容、凭据或临时 profile 提交到仓库。

## 失败时的第一检查

| 现象 | 先检查 | 不要先做什么 |
| --- | --- | --- |
| V2 不在新会话的 preset 菜单 | `agentPreset.list` 的真实响应、profile `--dump-config`、派生用户根和 `includeUserRoot` | 反复调整菜单 selector 或把 tarball 校验当作加载证明 |
| `value is not lossless JSON` | Host 返回值是否只提取需要的普通 JSON 字段，是否泄漏 live Session/Workspace/Tool 对象 | 对 live snapshot 使用 `JSON.stringify`、`structuredClone` 或递归展示 |
| `invalid arguments` 或 artifact/revision 字段错误 | 当前 V2 工具 schema、严格对象字段、章节与父 artifact 的同章链 | 沿用 V1 `arguments` 包装、字符串化 JSON 或重试同一无效调用 |
| UI 显示已加载但操作无效 | 当前会话的 preset、prompt 可用性、Proposal 队列和页面/服务端诊断 | 增加浏览器直写或绕过人工 Proposal 审核 |
| Proposal 必须刷新页面才显示已应用 | `proposal/apply` 后用 fresh/dynamic locator 重新定位并在当前 disclosure 内等待精确状态，以及 loopback 响应 | 用页面重载或旧节点消失掩盖 Client 刷新问题 |
| 局部测试绿而浏览器红 | 已安装 tarball、实际 profile 组合、boot graph、`agentPreset.list` 和 keyless browser journey | 宣称插件可用或顺手修改 DSH 核心 |

## 完成证据

一次 V2 改动只有同时具备与改动相称的回归证据、打包产物证据、隔离 profile 的真实 roster 与 mount 证据、Proposal 同页刷新证据，以及浏览器或 loopback 的重启持久化读回证据，才可以报告为可用。完整 release qualification 仍要求其自身的干净源 checkout；这个安全门阻止运行时证据时，应单独报告，而不能把 focused 测试写成完整资格通过。
