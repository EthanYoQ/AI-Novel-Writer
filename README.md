# AI小说作家 / AI Novel Writer

AI小说作家是一个本地优先的桌面小说创作 IDE，面向中文长篇小说、角色设定、章节蓝图、参考小说拆解和本地模型生成工作流。

AI Novel Writer is a local-first desktop IDE for long-form fiction. It combines story architecture, character state tracking, chapter blueprints, reference novel analysis, drafting, revision, review, and local or OpenAI-compatible model providers.

## Core Features

- Story architecture workflow: premise, character dynamics, worldbuilding, synopsis, and chapter blueprints.
- Chapter production workflow: draft, refine, review, revise, and finalize.
- Reference novel workflow: import TXT or Markdown, split chapters, infer structure, extract style constraints, and generate imitation guidance.
- Local-first project storage with SQLite-backed metadata and manuscript data.
- Local model support through Ollama and other OpenAI-compatible endpoints.
- Configurable prompts for architecture, drafting, revision, review, import, and style analysis.
- IDE-style workspace with sidebar navigation, editor tabs, AI output, task progress, and project settings.

## 核心能力

- 故事架构流程：故事前提、角色图谱、世界观、情节大纲、章节蓝图。
- 章节生产流程：草稿、精修、审稿、修订、定稿。
- 参考小说流程：导入 TXT 或 Markdown，自动拆章，反推结构，提取文风约束，生成仿写指南。
- 本地优先的数据存储，项目元数据和正文数据保存在本机。
- 支持 Ollama 与 OpenAI 兼容接口，适合接入本地模型。
- 内置提示词模板可调整，覆盖架构、写稿、修稿、审稿、导入和文风分析。
- 专业写作 IDE 布局，包含左侧导航、编辑器标签、AI 输出、任务进度和项目设置。

## Local Model Setup

Recommended local provider:

- Provider: custom or Ollama
- Protocol: OpenAI-compatible
- Base URL: `http://127.0.0.1:11434/v1`
- API key: `ollama`
- Model example: `qwen3-14b-abliterated-novel-q4`

The built-in prompt templates are tuned for local Qwen3 14B Q4-class generation: short instructions, concrete output contracts, chapter-bound drafting, repetition control, and evidence-bound extraction for imported novels.

## 本地模型配置

推荐本地连接方式：

- 服务商：custom 或 Ollama
- 协议：OpenAI-compatible
- Base URL：`http://127.0.0.1:11434/v1`
- API key：`ollama`
- 模型示例：`qwen3-14b-abliterated-novel-q4`

内置提示词已针对本地 Qwen3 14B Q4 级别模型做约束：短句、明确步骤、具体输出格式、只写本章、控制重复，并在导入小说拆解时坚持证据约束。

## Development

Requirements:

- Node.js 18 or newer
- pnpm or npm
- Windows, macOS, or Linux desktop environment for Electron packaging

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Run tests:

```bash
npm exec vitest -- run
```

Run TypeScript checks:

```bash
npm exec tsc -- --noEmit
```

Build the Vite and Electron bundles:

```bash
npm exec vite -- build
```

Full Electron packaging uses `electron-builder`:

```bash
npm run build
```

On Windows, full packaging may require Developer Mode or an elevated terminal because `electron-builder` extracts signing tools that contain symbolic links.

## 开发

安装依赖：

```bash
npm install
```

启动开发服务器：

```bash
npm run dev
```

运行测试：

```bash
npm exec vitest -- run
```

运行 TypeScript 检查：

```bash
npm exec tsc -- --noEmit
```

构建前端和 Electron bundle：

```bash
npm exec vite -- build
```

完整 Electron 打包：

```bash
npm run build
```

Windows 完整打包可能需要开启开发者模式或使用管理员终端，因为 `electron-builder` 解压签名工具时会创建符号链接。

## Data Safety

Do not commit local writing projects, imported novels, generated drafts, private model keys, local `.env` files, or application data directories.

The app may use internal compatibility paths such as project metadata directories and virtual document protocols. These are implementation details for existing project compatibility and should be migrated deliberately rather than renamed by broad text replacement.

## 数据安全

不要提交本机小说项目、导入参考小说、生成正文、私有模型密钥、本地 `.env` 文件或应用数据目录。

应用内部可能存在用于兼容旧项目的元数据目录和虚拟文档协议。这些是兼容层实现细节，应通过迁移逻辑逐步替换，不能直接做全局文本替换。

## License

This project is distributed under the GPL-3.0 license. See [LICENSE](LICENSE).
