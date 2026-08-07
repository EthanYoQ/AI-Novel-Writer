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
  <a href="https://github.com/EthanYoQ/AI-Novel-Writer/blob/master/LICENSE"><img src="https://badgen.net/badge/license/GPL-3.0/blue" alt="GPL-3.0 License" /></a>
  <a href="https://github.com/EthanYoQ/AI-Novel-Writer/stargazers"><img src="https://badgen.net/github/stars/EthanYoQ/AI-Novel-Writer" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest">下载最新 Windows 与 macOS ARM64 安装包</a>
</p>

<p align="center">
  <img src="docs/assets/readme/hero-zh-v2.png" alt="AI 小说作家——本地优先的长篇小说创作桌面工作台" width="100%" />
</p>

> ## v0.7.0 重大更新
>
> [v0.7.0](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.7.0) 是一次面向发布可靠性和界面外观的重大更新：提供经典、原创二次元与自定义图片皮肤，经典皮肤仍为默认外观。自定义图片只接受 PNG 或 JPEG，文件由主进程选择、验证并复制到应用数据目录；导入或读取失败会安全回退到经典皮肤，界面不会取得本机绝对路径。Windows 的“立即重启更新”现在会静默完成安装并自动拉起新版本；同时新增正式 Release 应用内更新端到端验收能力，用于验证已安装正式版升级到较新正式版的路径。Windows x64 与 macOS ARM64 的云端资格构建还会运行双平台打包皮肤 smoke，覆盖内置资源和隔离用户目录中的自定义皮肤恢复。
>
> 本版在同一个 Release 资产列表中提供 Windows x64 与 macOS Apple Silicon（ARM64）安装包。Windows x64 安装程序支持应用内更新，但尚未配置代码签名；macOS ARM64 包未签名、未公证，且需要从 Release 页面手动下载更新。首次安装时，系统安全提示或 Gatekeeper 可能要求用户确认。

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

![AI 小说作家主界面，展示项目结构、欢迎页、AI 写作助手和任务面板](docs/assets/readme/ui-zh.png)

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 结构化创作流程 | 从前提、角色、世界观到章节蓝图、草稿、审稿、修稿和定稿，按阶段组织创作资产。 |
| 章节级生成 | 生成时围绕当前章节的蓝图和相关资料组织上下文，减少跨章跑题。 |
| 审稿与修稿 | 为草稿生成结构化审稿信息，并以报告作为修稿输入。 |
| 角色卡与项目资料 | 在项目内维护角色、世界观、蓝图、草稿和定稿；项目会话机制避免旧窗口向重新打开的项目写入数据。 |
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
3. 安装后可在欢迎页使用“检查更新”。发现正式更新后，应用先下载，再提供“立即重启更新 / 稍后”的选择。
4. 旧版便携 ZIP 不能自行获得首个更新器版本，需要手动安装一次正式安装包；后续不再维护新的便携 ZIP。

当前安装程序尚未进行代码签名。Windows 可能显示发布者或信誉提示；请确认下载页面属于本项目的官方 GitHub Release 后再继续。

### macOS Apple Silicon（ARM64）

从 [GitHub Releases](https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest) 下载：

```text
ai-novel-writer-mac-arm64-<版本号>-installer.dmg
```

1. 此包仅适用于 Apple Silicon Mac（M1、M2、M3、M4 等 ARM64 机型），不提供 Intel Mac 安装包。
2. 将 DMG 中的应用拖入“应用程序”文件夹后启动；本版本不提供 macOS 应用内更新，请从同一 Release 页面手动下载后续版本。
3. 该包未签名、未公证。若 Gatekeeper 阻止打开，请确认来源是本项目的官方 GitHub Release，然后在 Finder 中按住 Control 点击应用并选择“打开”，或在“系统设置 → 隐私与安全性”中允许打开。

## 当前限制

- 不承诺任意第三方 API 都能仅靠 URL 和 Key 接入；只保证已实现协议与预设范围内的行为。
- 不替代作者的创意、事实核查或版权判断；AI 输出需要作者审阅。
- 不提供在线发布、阅读社区或云端模型账号。
- 正式安装包由 GitHub Actions 云端构建；Windows 与 macOS ARM64 会各自通过资格检查后，才会进入同一个 GitHub Release。

## 许可证

[GPL-3.0](LICENSE)
