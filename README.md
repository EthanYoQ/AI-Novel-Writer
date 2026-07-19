<p align="center">
  <img src="docs/assets/readme/hero-zh-v2.png" alt="AI 小说作家编辑部写作桌视觉首图" width="100%" />
</p>

# AI小说作家 - AI写作与小说创作工具

[English README](README_en.md) | [Windows v0.2.0 发布包](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.2.0) | [GPL-3.0 license](LICENSE)

AI小说作家是 GPL-3.0 的本地优先 AI 写作和小说创作工具，面向中文网文、长篇小说和故事项目作者。它把小说大纲、角色设定、世界观、章节细纲、正文生成、审稿修稿、知识库检索和参考小说拆解放在一个桌面工作台里，让 AI 写小说不再只是一次性聊天。

搜索意图：适合正在找 AI写作/AI写小说、小说创作/网文写作工具、本地小说写作软件 的创作者。

下载入口：[GitHub Releases](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.2.0) 提供 Windows x64 zip。项目数据默认保存在本机项目目录和 SQLite 数据库中；如果你配置外部 API 或本地模型服务，提示词和上下文会发送给对应模型端点。本项目不是 Sudowrite 官方产品，也不声明功能等价或写作质量等价。

![AI小说作家主界面](docs/assets/screenshot-main.png)

## v0.2.0 更新

- 修复 Windows 发布包中 LanceDB 原生绑定缺失造成的启动失败，并改为按需加载知识库。
- 新增简体中文与 English 界面切换：首次启动跟随系统语言，手动选择会持久保存；不改动内置创作提示词、生成正文或项目数据。
- 发布流程会验证打包后的 EXE、原生模块和主窗口启动；下载 `AI-Novel-Writer-0.2.0-windows-x64.zip` 后请完整解压再运行 `AI小说作家.exe`。

## Windows 发布包

发布形式是一个 zip 压缩文件夹：

```text
AI-Novel-Writer-0.2.0-windows-x64.zip
└─ AI-Novel-Writer/
   ├─ AI小说作家.exe
   ├─ resources/
   └─ Electron runtime files...
```

使用方式：

1. 下载并解压 `AI-Novel-Writer-0.2.0-windows-x64.zip`。
2. 进入解压后的 `AI-Novel-Writer` 文件夹。
3. 双击 `AI小说作家.exe` 启动软件。

## 核心能力

- 长篇小说项目管理：项目配置、故事前提、世界观、角色卡、章节蓝图、草稿、修稿、审稿报告和定稿内容保存在本机项目中。
- 故事架构：按步骤生成故事前提、角色图谱、世界观和情节大纲。
- 章节蓝图：为每章记录章节目的、叙事功能、出场角色、关键事件和悬念钩子。
- 正文生成与修稿：读取项目配置、蓝图、角色卡、世界观、文风约束和历史摘要，生成草稿、修稿和定稿。
- 审稿驱动修复：先生成结构化审稿报告，再用报告驱动修稿，处理剧情连贯性、角色状态、设定冲突和章节逻辑问题。
- 知识库检索：支持 TXT/Markdown 文档和文件夹导入；有 embedding 配置时走向量检索，缺失时降级到 SQLite FTS 全文检索。
- 参考小说拆解：导入 TXT/Markdown 小说后拆章、反推全局配置、提取角色卡、生成章节蓝图，并生成文风仿写约束。
- 模型接入：支持 OpenAI-compatible 和 Gemini 协议，可连接 Ollama、LM Studio、vLLM、KoboldCpp、DeepSeek、Grok、OpenAI、Gemini 等端点。

## 工作流

```text
创作脑洞 / 项目配置
        ↓
故事前提 → 角色图谱 → 世界观 → 情节大纲
        ↓
角色卡 / 关系图谱 / 状态追踪
        ↓
章节蓝图
        ↓
正文草稿 → 审稿报告 → 修稿版本 → 定稿
        ↓
知识库回写、角色状态更新、后续章节继续读取
```

## 本地模型建议

```text
Provider: custom / Ollama
Protocol: OpenAI-compatible
Base URL: http://127.0.0.1:11434/v1
API key: ollama
Model: your-local-model-name
```

内置提示词已针对本地 Qwen3 14B Q4 级别模型做过收敛：短指令、明确字段、结构化输出、分阶段生成、降低重复、只写本章、保留角色和蓝图约束。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm run typecheck
pnpm test
```

构建 Windows 文件夹 zip 发布包：

```bash
pnpm run build:win-zip
```

## 数据安全

不要提交本机小说项目、导入的参考小说全文、生成的草稿/修稿/定稿正文、`.env`、API key、本地模型配置、用户目录应用数据、`release/`、`dist/`、`dist-electron/` 或 `node_modules/`。
