# AI小说作家 / AI Novel Writer - Local-first AI fiction writing IDE

<p>
  <img src="https://api.iconify.design/simple-icons:github.svg?color=%23181717" width="28" alt="GitHub" />
</p>

[中文 README](README_zh.md) | [Windows release v0.1.0](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.1.0) | [GPL-3.0 license](LICENSE)

AI Novel Writer is a GPL-3.0, local-first desktop IDE for AI-assisted fiction writing, especially structured Chinese web-novel and long-form fiction workflows. It keeps novel projects in local folders with SQLite-backed data, then coordinates story architecture, character cards, worldbuilding, chapter blueprints, drafting, review, revision, knowledge retrieval, and reference-style analysis in one workspace.

AI小说作家是一个本地优先的桌面小说创作 IDE。它把设定约束、故事架构、角色图谱、世界观、章节蓝图、正文生成、审稿修稿、知识库检索、参考小说拆解与仿写约束放在同一个工作台里，让 AI 写作不再只是一次性聊天，而是按可追踪的创作流程推进。

Search intent: `AI novel writer`, `AI-assisted fiction writing`, `fiction writing IDE`, `novel writing IDE`, `local-first writing app`, `AI 小说写作`, `小说创作 IDE`, `AI 网文写作工具`, `Sudowrite alternative direction`.

Download the Windows x64 zip from [GitHub Releases](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.1.0). The app is local-first, but configured local model endpoints or external APIs may receive prompt and context data. This project is not an official Sudowrite product and does not claim feature parity or writing-quality equivalence.

![AI小说作家主界面](docs/assets/screenshot-main.png)

## Windows 发布包 / Windows Release Package

Windows 发布形式是一个 zip 压缩文件夹：

```text
AI-Novel-Writer-0.1.0-windows-x64.zip
└─ AI小说作家/
   ├─ AI小说作家.exe
   ├─ resources/
   └─ Electron runtime files...
```

使用方式：

1. 下载并解压 `AI-Novel-Writer-0.1.0-windows-x64.zip`。
2. 进入解压后的 `AI小说作家` 文件夹。
3. 双击 `AI小说作家.exe` 启动软件。

The Windows release is distributed as a zipped application folder. Extract the archive, open the `AI小说作家` folder, and launch `AI小说作家.exe`.

## 核心作用 / What It Does

<img src="https://api.iconify.design/lucide:book-open-text.svg?color=%23845a2b" width="20" alt="book" /> **长篇小说项目管理**

每个小说项目都有独立目录和 SQLite 数据库，用来保存项目配置、故事前提、世界观、角色卡、章节蓝图、草稿、修稿、审稿报告和定稿内容。项目数据保存在本机，不需要上传到云端。

<img src="https://api.iconify.design/lucide:settings.svg?color=%23845a2b" width="20" alt="settings" /> **约束设定与全局配置**

软件先把创作脑洞转成可执行配置：题材、细分类别、目标读者、总章数、单章字数、叙事视角、故事结构、核心大纲、世界设定、主角档案、金手指、全局写作要求和文风约束。这些字段会持续注入后续流程，减少 AI 跑偏。

<img src="https://api.iconify.design/lucide:network.svg?color=%23845a2b" width="20" alt="network" /> **故事架构与角色图谱**

架构流程按步骤生成故事前提、角色图谱、世界观和情节大纲。角色图谱会进一步拆成角色卡，写入数据库，供角色管理、关系图谱、章节写稿和后处理读取。

<img src="https://api.iconify.design/lucide:file-text.svg?color=%23845a2b" width="20" alt="file text" /> **章节蓝图**

蓝图不是简单目录，而是每章的执行约束：章节编号、标题、章节目的、叙事功能、出场角色、关键事件、悬念钩子等。正文生成会读取蓝图，保证每章围绕既定事件推进，不随意跳出大纲。

<img src="https://api.iconify.design/lucide:pen-line.svg?color=%23845a2b" width="20" alt="pen" /> **正文生成、修稿与定稿**

写稿流程读取项目配置、蓝图、角色卡、世界观、文风约束和历史摘要，生成章节草稿。修稿流程可以根据用户指令做局部或整体精修；定稿后会写入数据库，并同步生成章节 `.txt` 文件。

<img src="https://api.iconify.design/lucide:search-check.svg?color=%23845a2b" width="20" alt="review" /> **审稿与审稿驱动修复**

审稿流程会读取章节正文、角色状态、世界观和知识库检索结果，生成结构化审稿报告。之后可以用审稿报告驱动修稿，优先解决剧情连贯性、角色状态、设定冲突和章节逻辑问题。

<img src="https://api.iconify.design/lucide:database.svg?color=%23845a2b" width="20" alt="database" /> **知识库与参考资料检索**

项目知识库支持导入文本、文件和文件夹。底层使用 SQLite FTS 与 LanceDB 向量库：有可用 embedding 模型时走向量检索；embedding 不可用时降级到全文检索。写稿和审稿可引用知识库上下文。

<img src="https://api.iconify.design/lucide:upload.svg?color=%23845a2b" width="20" alt="upload" /> **已有小说导入与文风拆解**

导入 TXT/Markdown 后，软件会拆章、采样、反推全局配置、提取角色卡、生成章节蓝图，并分析参考文本的节奏、句式、描写密度、对话方式、场景推进和仿写指南。该能力用于“结构启发”和“文风约束”，不是复制原文情节。

<img src="https://api.iconify.design/lucide:brain-circuit.svg?color=%23845a2b" width="20" alt="model" /> **本地模型与外部 API**

模型层支持 OpenAI-compatible 和 Gemini 协议。你可以接 Ollama、LM Studio、vLLM、KoboldCpp 的兼容接口，也可以接 DeepSeek、Grok、OpenAI、Gemini 等外部 API。设置页可管理模型、默认模型、温度、上下文长度和输出长度。

<img src="https://api.iconify.design/lucide:package-check.svg?color=%23845a2b" width="20" alt="package" /> **本地优先发布**

Windows 版以 zip 文件夹发布，`AI小说作家.exe` 是启动器。应用运行数据默认在用户本机目录和项目目录中，不随源码发布。

## 工作机制 / How The Workflow Works

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

关键机制：

- 全局配置提供长期约束，避免模型每章重新发明设定。
- 角色卡记录身份、性格、动机、关系和当前状态，写稿时作为上下文读取。
- 章节蓝图控制单章目标、关键事件和钩子，减少跳章、跑题和提前写结局。
- 知识库检索把参考资料、已写章节和导入资料转成可召回上下文。
- 审稿与修稿拆成两个流程，先发现问题，再基于问题最小改动修复。
- 本地模型输出不稳定时，部分结构化流程带 JSON 容错解析和源文本兜底。

## English Overview

AI Novel Writer is designed for writers who want AI to follow a production pipeline rather than improvise endlessly in a chat window.

Core capabilities:

- **Project workspace:** project-level configuration, SQLite-backed manuscript data, editor tabs, task progress, logs, and local files.
- **Story architecture:** premise, character dynamics, worldbuilding, synopsis, and configurable plot structures.
- **Character system:** generated character cards, relationship graph support, role ordering, and chapter-by-chapter state tracking.
- **Chapter blueprints:** per-chapter purpose, role, key events, characters, and suspense hook.
- **Drafting pipeline:** generate, refine, review, review-driven revision, and finalize chapters.
- **Reference analysis:** import TXT/Markdown novels, split chapters, infer structure, analyze writing style, and produce imitation constraints.
- **Knowledge base:** document import, text chunking, SQLite FTS, LanceDB vector search, and fallback retrieval.
- **Model providers:** local OpenAI-compatible endpoints such as Ollama or LM Studio, plus external OpenAI-compatible APIs and Gemini.
- **Prompt system:** built-in and custom prompt templates for architecture, drafting, review, revision, import, style analysis, and post-processing.

## 本地模型建议 / Local Model Setup

推荐本地连接方式：

```text
Provider: custom / Ollama
Protocol: OpenAI-compatible
Base URL: http://127.0.0.1:11434/v1
API key: ollama
Model: your-local-model-name
```

Recommended local provider:

```text
Provider: custom / Ollama
Protocol: OpenAI-compatible
Base URL: http://127.0.0.1:11434/v1
API key: ollama
Model: your-local-model-name
```

内置提示词已针对本地 Qwen3 14B Q4 级别模型做过收敛：短指令、明确字段、结构化输出、分阶段生成、降低重复、只写本章、保留角色和蓝图约束。

## 开发 / Development

安装依赖：

```bash
npm install
```

启动开发环境：

```bash
npm run dev
```

类型检查：

```bash
npm exec tsc -- --noEmit
```

运行测试：

```bash
npm exec vitest -- run
```

构建 Windows 文件夹 zip 发布包：

```bash
npm run build:win-zip
```

产物路径：

```text
release/0.1.0/AI小说作家-0.1.0-windows-x64.zip
```

## 数据安全 / Data Safety

不要提交以下内容：

- 本机小说项目目录
- 导入的参考小说全文
- 生成的草稿、修稿和定稿正文
- `.env`、API key、本地模型配置文件
- 用户目录下的应用数据
- `release/`、`dist/`、`dist-electron/`、`node_modules/`

Do not commit local writing projects, imported novels, generated manuscripts, API keys, environment files, user data folders, or build output.

## License

This project is distributed under the GPL-3.0 license. See [LICENSE](LICENSE).
