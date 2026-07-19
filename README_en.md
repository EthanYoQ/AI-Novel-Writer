<p align="center">
  <img src="docs/assets/readme/hero-en-v2.png" alt="AI Novel Writer editorial writing desk hero image" width="100%" />
</p>

# AI Novel Writer - AI fiction writing and novel creation tool

[中文 README](README.md) | [Windows v0.2.0 release](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.2.0) | [GPL-3.0 license](LICENSE)

AI Novel Writer is a GPL-3.0, local-first desktop tool for AI-assisted fiction writing. It is aimed at structured web-novel, long-form fiction, and story projects, bringing outlines, characters, worldbuilding, chapter blueprints, drafting, review and revision, knowledge retrieval, and reference-novel analysis into one workspace.

The Windows x64 package is available from [GitHub Releases](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.2.0). Project data is stored in local project folders and SQLite databases by default. If you configure an external API or local model service, prompts and context are sent to that model endpoint. This is not an official Sudowrite product and does not claim feature or quality equivalence.

## v0.2.0 update

- Fixes Windows startup failures caused by a missing LanceDB native binding and loads the knowledge base on demand.
- Adds persistent Simplified Chinese / English UI switching. First launch follows the operating-system language; creative prompts, generated prose, and project data stay unchanged.
- The release process verifies the packaged EXE, native module, and main-window startup. Download `AI-Novel-Writer-0.2.0-windows-x64.zip`, extract it completely, then run `AI小说作家.exe`.

## Windows release package

The Windows release is a zipped application folder:

```text
AI-Novel-Writer-0.2.0-windows-x64.zip
└─ AI-Novel-Writer/
   ├─ AI小说作家.exe
   ├─ resources/
   └─ Electron runtime files...
```

1. Download and extract `AI-Novel-Writer-0.2.0-windows-x64.zip`.
2. Open the extracted `AI-Novel-Writer` folder.
3. Launch `AI小说作家.exe`.

## Core capabilities

- **Long-form project management:** local project configuration, premise, worldbuilding, character cards, chapter blueprints, drafts, revisions, review reports, and final manuscripts.
- **Story architecture:** generate a premise, character dynamics, worldbuilding, and plot synopsis in deliberate steps.
- **Chapter blueprints:** define each chapter's purpose, narrative role, cast, key events, and suspense hook.
- **Drafting and revision:** use project configuration, blueprints, character cards, worldbuilding, style constraints, and history summaries to generate drafts, revisions, and final chapters.
- **Review-driven repair:** create a structured review report, then revise against its findings for continuity, character state, setting conflicts, and chapter logic.
- **Knowledge retrieval:** import TXT/Markdown documents and folders; use vector retrieval when an embedding configuration is available, with SQLite FTS fallback otherwise.
- **Reference analysis:** import TXT/Markdown fiction, split chapters, infer global configuration, extract character cards and blueprints, and generate style constraints.
- **Model connections:** supports OpenAI-compatible and Gemini protocols, including Ollama, LM Studio, vLLM, KoboldCpp, DeepSeek, Grok, OpenAI, and Gemini endpoints.

## Workflow

```text
Story idea / project configuration
        ↓
Premise → Character dynamics → Worldbuilding → Synopsis
        ↓
Character cards / relationship graph / state tracking
        ↓
Chapter blueprints
        ↓
Draft → Review report → Revision → Final manuscript
        ↓
Knowledge-base updates, character-state updates, and later chapters
```

## Local model setup

```text
Provider: custom / Ollama
Protocol: OpenAI-compatible
Base URL: http://127.0.0.1:11434/v1
API key: ollama
Model: your-local-model-name
```

The built-in prompts were tuned for local Qwen3 14B Q4-class models with short instructions, explicit fields, structured output, staged generation, lower repetition, one-chapter scope, and retained character and blueprint constraints.

## Development

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm run typecheck
pnpm test
```

Build the Windows ZIP package:

```bash
pnpm run build:win-zip
```

## Data safety

Do not commit local writing projects, imported reference novels, generated drafts/revisions/final manuscripts, `.env` files, API keys, local model configuration, user application data, `release/`, `dist/`, `dist-electron/`, or `node_modules/`.
