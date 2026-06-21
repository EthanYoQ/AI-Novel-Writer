# AI小说作家 - 本地优先 AI 小说创作 IDE

[English README](README.md) | [Windows v0.1.0 发布包](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.1.0) | [GPL-3.0 license](LICENSE)

AI小说作家是 GPL-3.0 的本地优先桌面小说创作 IDE，面向需要把 AI 写作纳入可追踪流程的中文网文和长篇小说创作者。它把设定约束、故事架构、角色卡、世界观、章节蓝图、正文生成、审稿修稿、知识库检索、参考小说拆解与文风仿写约束放在一个工作台里。

搜索意图：`AI 小说写作`、`AI 小说作家`、`小说创作 IDE`、`AI 网文写作工具`、`本地优先写作软件`、`小说写作 AI 工具`、`local-first writing app`、`fiction writing IDE`、`Sudowrite alternative direction`。

下载入口：[GitHub Releases](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.1.0) 提供 Windows x64 zip。项目数据默认保存在本机项目目录和 SQLite 数据库中；如果你配置外部 API 或本地模型服务，提示词和上下文会发送给对应模型端点。本项目不是 Sudowrite 官方产品，也不声明功能等价或写作质量等价。

![AI小说作家主界面](docs/assets/screenshot-main.png)

## Windows 发布包

发布形式是一个 zip 压缩文件夹：

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
npm install
npm run dev
npm exec tsc -- --noEmit
npm exec vitest -- run
```

构建 Windows 文件夹 zip 发布包：

```bash
npm run build:win-zip
```

## 数据安全

不要提交本机小说项目、导入的参考小说全文、生成的草稿/修稿/定稿正文、`.env`、API key、本地模型配置、用户目录应用数据、`release/`、`dist/`、`dist-electron/` 或 `node_modules/`。
