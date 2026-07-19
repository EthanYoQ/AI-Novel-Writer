<p align="center">
  <img src="docs/assets/readme/hero-en-v2.png" alt="AI Novel Writer — your AI-driven desktop workspace for long-form fiction" width="100%" />
</p>

# AI Novel Writer

**中文 README**：[README.md](README.md) · **Download**：[Windows v0.2.0 zip](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.2.0) · **License**：[GPL-3.0](LICENSE)

> Local-first desktop workspace for AI long-form fiction. Your story. Your data. Your model.

The hardest part of writing a novel with AI isn't speed — it's **opening chapter 31 and finding that the thread you planted in chapter 5 has vanished**, the protagonist's personality has drifted, a side character disappeared, and the model is now writing fanfiction of itself. **AI Novel Writer** turns "premise → characters → world → chapter blueprints → draft → review → revision → final" into a single memory-aware production line. The model writes one chapter at a time, always sees the blueprint, every chapter gets reviewed. **Runs locally. Plugs into any OpenAI-compatible endpoint.**

---

## Three reasons to try it

- 🔓 **Local models, uncensored writing** — Plug in Ollama, LM Studio, vLLM, KoboldCpp, or any abliterated / uncensored weights (e.g. Qwen3 14B Q4) and write past the safety guardrails baked into cloud APIs.
- 🎨 **Decompose a novel. Mimic its voice.** — Drop in a reference novel (TXT or Markdown). It splits chapters, infers the global config, extracts character cards, and outputs a **style constraint** your future writing can reference.
- 🧩 **Characters, outline, and blueprints that bite together** — Change a character's motivation and every affected blueprint is auto-flagged. Finish a chapter draft and the knowledge base absorbs it. **Drift, contradiction, and out-of-character scenes are caught by structure, not by prompts.**

---

![AI Novel Writer main window](docs/assets/readme/ui-en.png)

## Why this stops AI from breaking your long-form novel

### 1. Local models. Zero content policy.

Cloud providers will not make an exception just because you are writing fiction — **your protagonist gets hurt in chapter 4 and the model refuses to continue**. Local models do not have that problem:

| Connection | Best for |
| --- | --- |
| **Ollama** (recommended) | One-line `ollama pull qwen3:14b-abliterated` and you're set |
| LM Studio / vLLM / KoboldCpp | Local inference servers, OpenAI-compatible protocol |
| OpenAI / DeepSeek / Gemini | Cloud fallback when you don't want to run a model locally |
| Custom OpenAI-compatible endpoint | Corporate proxy, internal inference service, or your own rig |

The built-in prompts are tuned for **Qwen3 14B Q4-class** models: short instructions, explicit fields, structured output, staged generation, lower repetition, single-chapter scope, character + blueprint constraints preserved.

> Set `defaultModelId` in `~/.vela/config.json` to your local model name. Project data lives entirely on disk (SQLite + project folder). **You can write offline.**

### 2. Style study: turn someone else's voice into yours

Pick a novel you love (TXT or Markdown). Run **Style Study**:

1. Auto-split into chapters
2. Infer the global config (genre, POV, pacing)
3. Extract per-character cards (background, motivation, speech habits)
4. Generate a blueprint for every chapter (purpose, cast, key beats, hooks)
5. **Output a style-constraint document** — attach it to your own project and the AI writes *in that voice* from then on

You are not teaching the model from scratch. You are transferring the **feel** of a book into your own generation pipeline.

### 3. Structured memory. The model never forgets chapter 5.

The hardest engineering problem in long-form AI fiction is **consistency**. AI Novel Writer's answer is to turn every creative asset into a **referenceable structure**:

```
Project config
  ├── Premise
  ├── Character map (per-character cards + relationship graph)
  ├── Worldbuilding
  ├── Plot outline
  ├── Chapter blueprints (purpose / POV / cast / key beats / hook)
  ├── Knowledge base (TXT/MD docs, vector + SQLite FTS retrieval)
  ├── Reference-novel decomposition artifacts
  └── Draft → Review report → Revision → Final
```

- **Edit a character card** → every blueprint that references them is auto-flagged
- **Finish a chapter draft** → knowledge base auto-indexes it; later chapters can search it
- **Before each generation** → assemble: this-chapter blueprint + relevant character cards + worldbuilding snippet + style constraints + history summary
- **After each draft** → produce a structured **review report** (character state, timeline, setting conflicts, in-chapter logic) and use it to drive a **revision pass**

The model only ever sees what it needs to see, but **nothing important gets forgotten**.

---

## Core capabilities

- 📚 **Long-form project management** — project config, premise, worldbuilding, character cards, chapter blueprints, drafts, revisions, review reports, and final manuscripts, all on disk
- 🧭 **Story architecture** — step-by-step generation of premise, character map, worldbuilding, plot outline
- 🗂️ **Chapter blueprints** — per-chapter purpose, narrative role, cast, key events, suspense hook
- ✍️ **Drafting and revision** — pull from project config, blueprints, character cards, worldbuilding, style constraints, and history summaries
- 🧐 **Review-driven repair** — produce a structured review report, then revise against its findings
- 📖 **Knowledge base** — import TXT/Markdown files and folders; vector retrieval when an embedding is configured, SQLite FTS fallback otherwise
- 🧬 **Reference analysis** — split, infer config, extract characters, generate blueprints, output style constraints
- 🔌 **Model freedom** — OpenAI-compatible + Gemini protocols; local or cloud
- 🌐 **Chinese / English UI** — follows system locale on first launch, manual choice persists

## The writing workflow

```text
   Story idea / project config
        │
        ▼
   Premise → Character map → Worldbuilding → Plot outline
        │
        ▼
   Character cards / relationship graph / state tracking
        │
        ▼
      Chapter blueprints
        │
        ▼
   Draft → Review report → Revision → Final
        │
        ▼
   Knowledge-base updates, character-state updates, later chapters
```

## 30-second setup with Ollama

```bash
# 1) Pull a local model (Qwen3 14B quantized — fits 6GB VRAM)
ollama pull qwen3:14b

# 2) In AI Novel Writer → Model settings, fill in:
#    Provider:        custom
#    Protocol:        OpenAI-compatible
#    Base URL:        http://127.0.0.1:11434/v1
#    API key:         ollama
#    Model:           qwen3:14b
#    (or use a community abliterated weight of your choice)

# 3) New project → write a one-line premise → let the AI generate
#    characters / world / blueprints → start chapter 1
```

## Windows install

The release is a zipped application folder:

```text
AI-Novel-Writer-0.2.0-windows-x64.zip
└─ AI-Novel-Writer/
   ├─ AI小说作家.exe
   ├─ resources/
   └─ Electron runtime files...
```

1. Download `AI-Novel-Writer-0.2.0-windows-x64.zip` from [GitHub Releases](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.2.0)
2. **Extract it fully** to any directory
3. Launch `AI小说作家.exe`

> ⚠️ Do not double-click the EXE inside the zip — Electron needs the relative `resources/` path. Extract first, then run.

## v0.2.0 highlights

- Fixed Windows startup failures from missing LanceDB native bindings; knowledge base now loads on demand
- Added persistent Simplified Chinese / English UI switch (follows OS language on first launch)
- Release pipeline now verifies the packaged EXE, native modules, and main-window startup

## Development

```bash
pnpm install --frozen-lockfile
pnpm dev              # local dev
pnpm run typecheck    # type check
pnpm test             # unit tests

# Build the Windows ZIP package
pnpm run build:win-zip
```

## Data safety

Do not commit to the repo:

- Local novel projects, imported reference novels
- Generated drafts, revisions, final manuscripts
- `.env` files, API keys, local model configuration
- `release/`, `dist/`, `dist-electron/`, `node_modules/`

Project data is stored in local project folders and SQLite databases by default. If you configure an external API or local model service, prompts and context are sent to that endpoint.

## License

[GPL-3.0](LICENSE).

This is not an official Sudowrite product and does not claim feature or quality equivalence.
