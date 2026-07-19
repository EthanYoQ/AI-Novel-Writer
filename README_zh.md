<p align="center">
  <img src="docs/assets/readme/hero-zh.svg" alt="AI 小说作家——本地优先的长篇小说生产工作台" width="100%" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest">下载 Windows 版</a> ·
  <a href="LICENSE">GPL-3.0</a>
</p>

AI 小说作家是一套本地优先的桌面创作工作台，把一个故事灵感推进为可管理的长篇生产流程：故事架构、角色、章节蓝图、草稿、审稿、修订与定稿。

它是编排层，不内置 AI 模型。你可以连接 OpenAI-compatible 或 Gemini 协议，既支持 Ollama、LM Studio 等本地端点，也支持外部 API。

![AI 小说作家主界面](docs/assets/screenshot-main.png)

## 为什么需要它

聊天窗口适合生成一个片段，长篇小说还需要长期记忆、约束、阶段门禁和可追溯产物。AI 小说作家把这些内容放进同一个项目工作台：

- 故事前提、角色图谱、世界观与情节大纲
- 可编辑的章节蓝图：目标、事件、角色与悬念钩子
- 草稿 → 审稿 → 修订 → 定稿流水线
- 角色卡、关系图谱与逐章状态追踪
- SQLite 全文检索与可选的 LanceDB 向量检索
- TXT/Markdown 参考小说导入、结构反推与文风分析
- 全局与项目级提示词覆盖
- 简体中文与英文应用界面

## v0.2.0 更新

这个版本重点解决启动可靠性与语言可访问性：

- 新增中英文切换，覆盖应用界面、系统提示和错误信息。首次启动跟随操作系统语言，手动选择会持久保存。
- 切换语言时不修改内置创作提示词、生成正文和项目数据。
- Windows 发布包显式包含 LanceDB 原生组件，并在打包后实际验证加载。
- 知识库改为按需加载；即使可选原生组件异常，也不会再阻止整个应用启动。
- 发布前自动清理旧产物，并验证可执行文件、`app.asar`、原生模块、进程稳定性和窗口创建。

## Windows 安装

1. 从 [GitHub Releases](https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest) 下载 `AI-Novel-Writer-0.2.0-windows-x64.zip`。
2. 完整解压 ZIP。
3. 打开解压后的 `AI-Novel-Writer` 文件夹。
4. 双击 `AI小说作家.exe`。

不要直接在压缩包内运行 EXE。目前正式发布目标为 Windows x64。

## 小说生产流程

```text
创作灵感 / 项目配置
          │
          ▼
故事前提 → 角色图谱 → 世界观 → 情节大纲
          │
          ▼
       章节蓝图
          │
          ▼
草稿 → 审稿 → 修订 → 定稿
          │
          ▼
知识库回写 + 角色状态更新
```

工作台把全局约束与单章意图分开管理。草稿可以先审稿，再根据报告修订；修订结果可以对比确认后再合并，不必直接覆盖原稿。

## 模型配置

本地 OpenAI-compatible 端点示例：

```text
服务商：Ollama 或 Custom
协议：OpenAI-compatible
Base URL：http://127.0.0.1:11434/v1
API key：ollama
模型：你的本地模型名称
```

应用本身不附带模型。配置外部服务商后，提示词和所选项目上下文会按照该服务商的隐私政策发送给它。

## 开发

需要 Node.js 20+、pnpm 11；桌面打包需要 Windows。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

质量检查：

```bash
pnpm run typecheck
pnpm test
pnpm run lint
```

构建并验证 Windows 目录包：

```powershell
pnpm run build:win-dir
pnpm run smoke:win-app
```

生成发布 ZIP 和校验文件：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-win-zip.ps1
```

预期产物：`release/0.2.0/AI-Novel-Writer-0.2.0-windows-x64.zip`。

## 数据与安全

项目文件和应用数据库默认保存在本机。不要提交小说项目、导入的参考小说、API key、`.env`、用户配置或发布目录。

应用可以连接本地或远程模型。“本地优先”指存储和流程编排；连接远程 API 时，数据仍会离开本机。

## 开源协议

本项目使用 [GNU General Public License v3.0](LICENSE)。
