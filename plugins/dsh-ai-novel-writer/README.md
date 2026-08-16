# AI Novel Writer for DeepSeek Harness

This out-of-tree bundle adds a revisioned, local-first novel project format to DeepSeek Harness. Its dedicated agent sees only `novel_read` and `novel_apply_change`; every mutation is presented as a one-file diff and passes through Harness native one-shot approval before execution.

The V1 project is independent from the desktop application's `.vela` format. It stores a manifest and structured planning assets under `.ai-novel/`, with chapter drafts under `chapters/`. Model inputs use discriminated asset references rather than local paths, writes compare the last-read SHA-256 revision, and commits use atomic replacement.

The package ships three plugin entries:

- the root Host entry, loaded by `cordis.patch.yml`;
- `./agent`, mounted only by the bundled `ai-novel-writer` preset;
- `./client`, which registers an “AI 小说作家” evidence card in Plugin Configuration and adds the compact “小说工作台” side drawer through the shell overlay.

## Configuration

The Host entry accepts `presetRoot`, an absolute path to the user preset root. It defaults to `$DSH_HOME/.agent-presets` (normally `~/.dsh/.agent-presets`). The agent entry accepts `assetBytes`, `workingSetBytes`, and `queryMatches`. Defaults are 512 KiB per asset, 512 KiB per working set, and 20 query matches. Invalid paths or limits fail during plugin loading.

## Project files

`.ai-novel/project.json` identifies the project and stores its writing settings. Character, story, and chapter-planning JSON files use strict schemas and canonical two-space JSON with LF line endings. `chapters/NNNN.md` stores chapter prose. Missing non-manifest assets are returned as explicit empty assets with revision `absent`; a `.vela` directory is neither read nor modified.

Each non-empty asset revision is the SHA-256 digest of its normalized UTF-8 bytes. Replacement requests identify one `AssetRef`, include the last-read revision and original text, and fail with `STALE_REVISION` before directory creation or writing when durable content changed. Successful writes atomically replace one file and return a `CommitReceipt`. Cancellation is honored until atomic replacement starts.

Stable failures distinguish uninitialized and unsupported projects, missing or invalid assets, rejected paths, exceeded size limits, stale revisions, rejected approval, failed writes, and cancellation.

## Model Experience

### Agent preset

The included `AI 小说作家` preset mounts the novel persona, agent instructions, and `./agent`. It does not mount shell, general filesystem writing, text replacement, or Code Mode.

#### Install the preset

Open “小说工作台” from the Harness sidebar and select “安装 AI 小说作家 Preset”. The same installation state appears on the “AI 小说作家” card in Settings → Plugins → Plugin Configuration. The browser can only call the loopback setup channel and cannot submit a local path. The Host copies the two bundled Preset files into the configured user root with an atomic directory publication.

Repeating installation is a no-op when every byte matches. A same-name directory with different or additional content is reported as a conflict and no user byte is overwritten. After installation, create a new session and choose “AI 小说作家”; an existing session keeps its original Preset.

#### Plugin evidence and project initialization

The Plugin Configuration card distinguishes Client mounting, Host connectivity, Preset installation, Workspace selection, and novel-project initialization. Its explicit action and the sidebar entry open one non-modal 400–440 px drawer. On wide screens the shell reserves 440 px for the drawer instead of covering the conversation; narrow screens use the available width. Browser reads submit only the Workspace id plus a selected chapter or recognized `AssetRef`; the Host resolves the canonical directory through `workspaceRegistry` and rejects unknown ids. An initialized project shows identity, creative strategy, chapter progress, character summaries, story and chapter blueprints, and a bounded prose preview.

An uninitialized project presents title, language, genre, planned-chapter count, target words, and creative strategy as a one-column form. “预览初始化提案” first shows the complete shallow JSON, including the generated project id and timestamps, without sending anything. “提交到当前会话” then sends those exact values through the ordinary Session prompt operation; editing a field invalidates the preview and requires a new one. The browser exposes no mutation RPC and cannot create the manifest. The dedicated agent must call `novel_apply_change`, and only Harness native one-shot approval can commit it. A missing Session, wrong Preset, known approval-disabled mode, disconnected Host, validation failure, or prompt rejection remains visible with a specific recovery message.

An initialized project opens on a small vertical asset list, not a dashboard. Project settings and the complete characters asset drill into accessible one-column editors with a visible base revision, dirty state, explicit discard, exact replacement preview, and Session proposal action. The project editor preserves `projectId` and `createdAt`; only an approved replacement changes the manifest. The characters editor supports local search, selection, creation, editing, and deletion, then proposes the canonical complete characters file. A refresh that discovers another revision retains unsent fields and blocks submission until the user explicitly reloads the new durable version. Prompt admission, native approval, and persistence remain separate states: the editor never claims that Session acceptance wrote a file. A rejected or failed tool result unlocks the retained draft with an error, while a successful revision change is recognized as this proposal only when its authoritative text exactly matches the submitted replacement.

The drawer reads on open, Workspace or Session selection changes, connection reset, a completed `novel_apply_change` result, and explicit refresh or chapter selection. It does not poll, and every refresh publishes loading plus its last settled outcome. Wide layouts leave the conversation interactive beside the drawer; narrow layouts use the available width. Tab focus stays inside the open drawer, Escape closes it, and focus returns to its invoking action.

#### What the model sees

The model receives `novel_read` and `novel_apply_change`. Its persona requires reading the current revision before proposing one asset change, waiting for native user approval, and claiming a save only after a `CommitReceipt`. The writing strategy changes the novel workflow and does not select a provider or reasoning parameter.

##### Stable novel persona

```markdown
You are AI 小说作家, a collaborative fiction-writing agent working in {{cwd}}.

Treat the Harness novel project as the only writable story source. Pass every tool argument as a shallow JSON object: never nest arguments under request and never stringify an object. Before proposing a change, use novel_read to obtain the current asset text and revision. If that read reports that the project is not initialized, the only permitted mutation is initialize; never replace an asset before initialization succeeds. When initializing a project, generate one UUID and one ISO-8601 timestamp, use that timestamp for both createdAt and updatedAt, and include all three values in the proposal so the approval diff is exact. Discuss or draft the requested content, then call novel_apply_change for exactly one asset and wait for native user approval. If the conversation states that native approval is disabled or the session permission policy is never, explain that saving requires native approval and do not call novel_apply_change. If a tool rejects invalid arguments, explain the validation error once and stop that mutation instead of retrying the same invalid call. Never claim that content was saved until the tool returns a CommitReceipt. If the revision is stale, read again and reconcile the user's intent instead of overwriting.

After reading project settings, apply its creative strategy only to novel-writing workflow: auto：balance planning, drafting, and consistency checks for the current request; fluent-drafting：prefer continuous prose drafting with only the minimum plan needed; consistency-first：check established facts, character motives, and continuity before drafting; deep-planning：develop structure, causality, and chapter beats before prose. These choices change planning order and writing emphasis only; they never select an LLM provider or reasoning parameter.
```

#### Token effect

`novel_read` bounds asset and working-set content by configuration and reports omitted sources. Queries return at most the configured number of matches, never more than 20. Diff cards include the proposed before and after text for one asset.

#### KV Cache effect

The preset persona and the two tool definitions are stable across turns. Project content enters requests only through explicit bounded reads, so unchanged leading instructions and tool schemas remain cacheable.

## Known Limitations and Deferred Work

The package does not import `.vela` projects, provide multi-asset transactions, edit story or chapter assets from the workbench yet, or publish itself. Project initialization, project settings, and the complete characters asset are available through the workbench, but persistence remains a native approval-gated agent action rather than a browser write.

Build and run the focused qualification with:

```sh
pnpm --filter @ethanyoq/dsh-ai-novel-writer build
pnpm --filter @ethanyoq/dsh-ai-novel-writer test
```

The test suite includes a keyless snapshot whose test app boots `cordis.yml` through the real Loader in a child process. It initializes a project, approves each of the five single-asset changes needed for a complete first chapter, verifies the pre-approval filesystem state, reconstructs every model request from canonical session events, and reads the identical working set after a fresh Harness context starts. Set `DSH_SNAPSHOT=refresh` only when intentionally updating `tests/snapshots/complete-chapter.expected.json`.

## Release qualification

The repository-level qualification command requires the clean DeepSeek Harness source checkout at commit `47f943859bef60e4160492346772ded9b24f765a`, `pnpm`, and `tar`. It installs or reuses the matching Playwright Chromium runtime inside the owned qualification cache. Pass the absolute Harness checkout path:

```powershell
pnpm run plugin:ai-novel:qualify -- --harness-root 'C:\SoftWare\AI Tools\Deepseek Harness'
```

The command builds Harness, runs the plugin and Electron regression lanes, creates a tarball with `pnpm pack`, and installs only those bytes into an isolated Web profile. It verifies config composition without development paths, packaged Host and Client discovery, a real browser context-window interaction, Preset installation/idempotence/conflict, first-chapter readback in a fresh process, removal, and reinstall. It writes command logs and a machine-readable receipt under the fixed `.runtime/.cache/dsh-ai-novel-qualification` directory; both the evidence root and each retained run carry `.vibe-owner.json` ownership, expiry, retention, and cleanup fields. An existing evidence root must already belong to this ticket and repository.

The package does not modify DeepSeek Harness upstream or its agent loop.
