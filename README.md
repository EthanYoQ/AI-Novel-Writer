<div align="center">

[English](README_en.md) | **中文**

</div>

<p align="center">
  <img src="docs/assets/readme/ai-novel-writer-logo-transparent.png" width="104" height="104" alt="AI 小说作家 Logo" />
</p>

<h1 align="center">AI 小说作家 / AI Novel Writer</h1>

<p align="center">
  面向长篇小说创作的本地优先桌面工作台。它把“前提 → 角色 → 世界观 → 章节蓝图 → 草稿 → 审稿 → 修稿 → 定稿”组织为一条可追溯的创作流程；模型由你自行配置，项目资料留在你的电脑上。
</p>

<p align="center">
  <a href="https://github.com/EthanYoQ/AI-Novel-Writer/releases"><img src="https://badgen.net/github/tag/EthanYoQ/AI-Novel-Writer?label=release" alt="Release" /></a>
  <a href="https://github.com/EthanYoQ/AI-Novel-Writer/tree/master/plugins/dsh-ai-novel-writer"><img src="https://badgen.net/badge/DSH%20plugin/0.1.0%20preview/blue" alt="DeepSeek Harness plugin 0.1.0 preview" /></a>
  <a href="https://github.com/EthanYoQ/AI-Novel-Writer/blob/master/LICENSE"><img src="https://badgen.net/badge/license/GPL-3.0/blue" alt="GPL-3.0 License" /></a>
  <a href="https://github.com/EthanYoQ/AI-Novel-Writer/stargazers"><img src="https://badgen.net/github/stars/EthanYoQ/AI-Novel-Writer" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest">下载桌面版（Windows / macOS）</a> · <a href="https://www.npmjs.com/package/@ethanyoq/dsh-ai-novel-writer">安装 DeepSeek Harness Web 插件</a>
</p>

> **DeepSeek Harness 插件提示：** `0.1.0` 预览版目前冻结维护，短期不扩展功能；它的能力不足桌面软件版的 10%，不能替代桌面版。需要完整项目树、批量工作流、成熟编辑器或自动审校时，请使用上方的桌面版。

<p align="center">
  <img src="docs/assets/readme/ui-zh-v085-project-config.png" alt="AI 小说作家 v0.8.5：在本地桌面工作台中配置长篇小说的故事前提、世界观、角色、蓝图与章节" width="100%" />
</p>

> ## v0.9.0 功能基线（历史发布）
>
> [v0.9.0](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.9.0) 让长篇小说的设定继承、章节控制与审稿修稿更完整，并继续提供 Windows、macOS Apple Silicon 与 macOS Intel 安装包：
>
> - **长篇一致性上下文继承**：作者明确填写的故事前提、角色、世界观、大纲、蓝图与已定稿事实会进入后续创作，减少长篇写作中的设定遗失和前后矛盾。
> - **伏笔与叙事线索系统**：可集中查看伏笔建议、埋设与回收章节、当前活跃线索及超期提醒，让长线悬念更容易规划和兑现。
> - **EPUB 导入与角色图谱操作**：支持导入 EPUB2 / EPUB3 正文并沿用现有章节拆分流程；角色关系图可缩放、平移和一键清空。
> - **章节模型与字数控制**：单章和连续写作都按本次选择的模型与每章目标字数执行；同一生成目标的重复任务会互斥并给出提示。
> - **人工审稿闭环**：AI 审稿意见可编辑、忽略、补充并确认，再按确认清单修稿，最后通过差异对比决定是否合并。
> - **模型配置更顺畅**：模型高级设置提供推理强度、温度等可用选项；填写 API Key 与 Base URL 后即可获取模型列表，不再陷入“未保存就不能获取”的循环。
> - **更准确的失败提示**：内容限制、模型调用和重复任务等失败会尽量显示具体原因，失败结果不会冒充成功内容写入项目。
>
> 同一个 Release 使用七项资产合同：`ai-novel-writer-setup-0.9.0.exe`、`ai-novel-writer-setup-0.9.0.exe.blockmap`、`latest.yml`、`ai-novel-writer-mac-arm64-0.9.0-installer.dmg`、`ai-novel-writer-mac-arm64-0.9.0-installer.dmg.sha256`、`ai-novel-writer-mac-x64-0.9.0-installer.dmg` 与 `ai-novel-writer-mac-x64-0.9.0-installer.dmg.sha256`。Windows 安装包未代码签名；两种 macOS 安装包为 ad-hoc 或未签名且未公证，首次打开可能需要按平台安全提示手动确认。


## DeepSeek Harness 插件（早期 MVP）

除了 Windows 与 macOS 桌面版，本仓库还保留 `@ethanyoq/dsh-ai-novel-writer` `0.1.0` 开发预览。该插件目前冻结维护，短期不扩展功能。DeepSeek Harness 的 V2 工作台是刻意收敛的早期 MVP，当前能力不足桌面软件版的 10%；它不读取桌面版 `.vela` 项目，也不能替代桌面版的项目树、批量工作流、成熟编辑器或自动审校。

V2 只提供人工审核的最小创作链：项目设置 → 故事架构 → 人物设定 → 全书纲要 → 逐章蓝图 → 逐章正文。模型生成的待审核建议到达 Proposal 收件箱后，会先填入右侧工作台的本地编辑表单，供人工查看和修改；只有用户明确审核并应用 Proposal，权威项目状态才会改变。

该插件不属于桌面版正式 Release，但已发布为独立 npm 包，拥有独立锁文件、CI 和 MIT 许可；仓库根目录仍为 GPL-3.0 桌面应用。将它安装到 DeepSeek Harness 的 `web` profile：

```sh
dsh plugin --profile web add @ethanyoq/dsh-ai-novel-writer
dsh --profile web
```

源码开发、固定 tarball 安装和 Windows 含空格路径限制由[插件安装指南](plugins/dsh-ai-novel-writer/docs/official-dsh-plugin-installation.md)单独维护，根 README 不复制这些易变化的维护者步骤。

启动 Web 后，打开“小说工作台”，安装 **“AI 小说作家 V2”** Preset；随后新建会话并选择该 Preset。V2 的 AI 起草结果会先回填到右侧工作台的本地编辑表单，供人工修改和审核；点击应用 Proposal 才会写入项目。完整功能、项目格式、验证范围和卸载方式见[插件说明](plugins/dsh-ai-novel-writer/README.md)。不要使用 `dsh plugin add github:EthanYoQ/AI-Novel-Writer`：仓库根包是桌面应用，不是可激活的 DSH bundle。



## 产品定位

AI 小说作家不是内置模型服务，也不是在线小说平台。它提供的是创作编排层：保存项目状态、组织提示词与上下文、管理章节蓝图和草稿版本，并把生成、审稿和修稿串起来。

你可以接入本地或云端模型；软件不会替你提供或托管模型额度。长篇创作时，系统会围绕当前章节蓝图、相关角色资料、世界观、历史摘要和可选参考文风组织上下文，而不是把整本小说塞进一次聊天记录。

```mermaid
flowchart LR
  A[创作前提] --> B[角色与世界观]
  B --> C[情节大纲与章节蓝图]
  C --> D[章节草稿]
  D --> E[审稿报告]
  E --> F[修稿与定稿]
  F --> G[下一章的项目上下文]
```

## 界面预览

![AI 小说作家 v0.8.5 主界面，展示虚构项目、小说配置、项目结构、AI 写作助手和任务面板](docs/assets/readme/ui-zh-v085-project-config.png)

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 结构化创作流程 | 从前提、角色、世界观到章节蓝图、草稿、审稿、修稿和定稿，按阶段组织创作资产。 |
| 章节级生成 | 生成时围绕当前章节的蓝图和相关资料组织上下文，减少跨章跑题。 |
| 审稿与修稿 | 为草稿生成结构化审稿信息，并以报告作为修稿输入。 |
| 角色卡与项目资料 | 在项目内维护角色、世界观、蓝图、草稿和定稿；项目会话机制避免旧窗口向重新打开的项目写入数据。 |
| 剧情树与叙事线索 | 以章节轨道展示主线、支线和来源进度；剧情树是可重建的只读快照，不会取代作者事实。 |
| 写作 Skills 与提示词模板 | 可按创作阶段绑定补充写作方法并定制中英文创作指导；语言、输出结构和工具协议仍由隐藏合同保护。 |
| 参考文本与知识库 | 可导入常见文本格式作为参考资料；未配置 embedding 时仍可使用 SQLite FTS 全文检索。 |
| 批量创作任务 | 单独的批量章节创作任务可设为 1–10 章，支持暂停、取消；后处理失败会停止后续章节。 |
| 中英文界面 | 首次启动可跟随系统语言，手动选择会持久保存。 |

## 模型配置

目前支持两类调用协议：

- **OpenAI-compatible**：适用于 OpenAI、DeepSeek、Ollama、NovelAI 预设及其他兼容 Chat Completions 的服务。
- **Gemini 原生协议**：适用于 Google Gemini 兼容端点。

“自定义 API”指的是在上述协议范围内自定义地址、模型标识和凭据；它不是任意 HTTP 协议或可执行脚本编辑器。Anthropic、Azure、KoboldAI 原生协议等不同接口需要单独的适配器，不能仅靠替换 URL 保证兼容。

### Ollama

推荐通过 Ollama 的 OpenAI-compatible 服务接入：

```text
Provider:  Ollama（本地）或自定义
Protocol:  OpenAI-compatible
Base URL:  http://127.0.0.1:11434/v1
API Key:   可留空；若界面要求，可填任意本地占位值
Model:     你的 Ollama 模型名，例如 qwen3:14b
```

向量模型也应使用 `/v1`。不要把 Base URL 写成 `http://127.0.0.1:11434/api`：`/api` 是 Ollama 的原生接口路径，不是本应用当前使用的 OpenAI-compatible embedding 路径。

### NovelAI（最小兼容支持）

设置中可选择 **NovelAI** 预设，默认地址为 `https://text.novelai.net/oa`，协议为 OpenAI-compatible。请使用自己的 Persistent API Token，并按账户实际可用模型填写模型标识。

本项目对该预设做了最小参数兼容：不向其发送标准 `response_format`，思考参数采用其兼容分支。由于维护者没有用户的 NovelAI Token，尚未进行真实账户的完整创作流程验证；遇到账号权限、模型名或接口差异时，请以 NovelAI 的账户和官方资料为准。

## 数据、隐私与边界

| 数据或行为 | 默认位置 / 去向 |
| --- | --- |
| 小说项目、角色、蓝图、草稿和定稿 | 你的项目目录与本地 SQLite 数据库。 |
| 导入的参考资料 | 保留在本地项目范围内，除非你自行把内容发送给云端模型。 |
| 本地模型请求 | 发送给你配置的本机或局域网推理服务。 |
| 云端模型请求 | 当你选择 OpenAI、DeepSeek、Gemini 或其他云端端点时，提示词和上下文会发送给该服务商。 |
| 模型配置与 API Key | 当前保存在本机用户目录 `~/.vela/models.json`；请保护操作系统账户，不要分享该文件。 |
| 应用偏好与更新延后设置 | 保存在 `~/.vela/config.json`。 |

软件本身不提供模型账号、云端生成服务或运营消息推送。联网更新检查只读取公开 GitHub Release；用户可手动检查，也可在发现更新后暂缓提醒。

## 安装与更新

### Windows x64

正式版使用 Windows NSIS 安装程序：

```text
ai-novel-writer-setup-<版本号>.exe
```

1. 只从 [GitHub Releases](https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest) 下载正式安装包。
2. 安装程序更新应用本身，不应删除小说项目、角色卡或已有设置；仍建议在升级前自行备份重要作品。
3. 安装后可在欢迎页使用“检查更新”；应用启动后也会按每日一次的成功检查频率静默检查。发现正式更新时先提示，只有用户点击“下载更新”后才开始下载；下载完成后再提供“立即重启更新 / 稍后”的选择。
4. 旧版便携 ZIP 不能自行获得首个更新器版本，需要手动安装一次正式安装包；后续不再维护新的便携 ZIP。

当前安装程序尚未进行代码签名。Windows 可能显示发布者或信誉提示；请确认下载页面属于本项目的官方 GitHub Release 后再继续。

### macOS（Apple Silicon 与 Intel）

从 [GitHub Releases](https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest) 下载与你的 Mac 架构对应的安装包：

```text
ai-novel-writer-mac-arm64-<版本号>-installer.dmg
ai-novel-writer-mac-x64-<版本号>-installer.dmg
```

1. `arm64` 适用于 Apple Silicon Mac（M1、M2、M3、M4 等）；`x64` 适用于 Intel Mac。
2. 将 DMG 中的应用拖入“应用程序”文件夹后启动。应用可以检查 GitHub 最新正式版并显示提醒，但不会在 macOS 内下载或替换程序；更新操作只打开官方 Release 页面，由用户手动下载对应架构的后续版本。
3. 两个安装包均未使用 Developer ID 签名且未公证（ARM64 为 ad-hoc 签名，x64 为未签名）。若 Gatekeeper 阻止打开，请确认来源是本项目的官方 GitHub Release，然后在 Finder 中按住 Control 点击应用并选择“打开”，或在“系统设置 → 隐私与安全性”中允许打开。

## 当前限制

- 不承诺任意第三方 API 都能仅靠 URL 和 Key 接入；只保证已实现协议与预设范围内的行为。
- 不替代作者的创意、事实核查或版权判断；AI 输出需要作者审阅。
- 不提供在线发布、阅读社区或云端模型账号。
- 正式安装包由 GitHub Actions 云端构建；Windows、macOS ARM64 与 macOS x64 会各自通过资格检查后，才会进入同一个 GitHub Release。

## 开发与架构文档

文档权威层级、ADR、调研、Agent 规则和任务交接入口见 [`docs/README.md`](docs/README.md)。DeepSeek Harness 插件拥有独立的[插件说明](plugins/dsh-ai-novel-writer/README.md)，不作为桌面版行为的来源。

## 许可证

[GPL-3.0](LICENSE)
