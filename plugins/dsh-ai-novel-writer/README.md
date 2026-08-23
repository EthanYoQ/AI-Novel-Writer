# AI Novel Writer for DeepSeek Harness

This out-of-tree bundle adds a revisioned, local-first novel project format to DeepSeek Harness. The legacy V1 dedicated agent sees only `novel_read` and `novel_apply_change`; every V1 mutation is presented as a one-file diff and passes through Harness native one-shot approval before execution.

> **Early V2 MVP.** The DeepSeek Harness V2 workbench is an intentionally narrow proof of the authoring chain. It currently offers less than 10% of the desktop application's capabilities and is not a replacement for the desktop product, its project workspace, batch workflows, mature editor, or automated review features.

The V1 project is independent from the desktop application's `.vela` format. It stores a manifest and structured planning assets under `.ai-novel/`, with chapter drafts under `chapters/`. Model inputs use discriminated asset references rather than local paths, writes compare the last-read SHA-256 revision, and commits use atomic replacement.

The package ships four plugin entries:

- the root Host entry, loaded by `cordis.patch.yml`;
- `./agent`, mounted only by the bundled V1 `ai-novel-writer` preset;
- `./agent-v2`, mounted only by the bundled V2 `ai-novel-writer-v2` preset;
- `./client`, which registers an “AI 小说作家” evidence card in Plugin Configuration and adds the compact “小说工作台” side drawer through the shell overlay.

## Install from npm

Install the published bundle into a DeepSeek Harness profile:

```sh
dsh plugin --profile web add @ethanyoq/dsh-ai-novel-writer
dsh --profile web
```

The desktop application at the repository root is separate and is not an activatable DSH bundle.

## Configuration

The Host entry accepts `presetRoot`, an absolute path to the user preset root. It defaults to `$DSH_HOME/.agent-presets` (normally `~/.dsh/.agent-presets`). The agent entry accepts `surface`, whose default `v1` preserves the original approval-gated file surface and whose `v2` value is set by the V2 Preset. V1 also accepts `assetBytes`, `workingSetBytes`, and `queryMatches`, with defaults of 512 KiB per asset, 512 KiB per working set, and 20 query matches. V2 accepts `maxProposalBytes` and `maxPendingProposals`, with defaults of 2 MiB and 20 pending proposals. Invalid paths or limits fail during plugin loading.

## Project files

`.ai-novel/project.json` identifies the project and stores its writing settings. Character, story, and chapter-planning JSON files use strict schemas and canonical two-space JSON with LF line endings. `chapters/NNNN.md` stores chapter prose. Missing non-manifest assets are returned as explicit empty assets with revision `absent`; a `.vela` directory is neither read nor modified.

Each non-empty asset revision is the SHA-256 digest of its normalized UTF-8 bytes. Replacement requests identify one `AssetRef` and include the last-read revision as the sole optimistic-concurrency value; they fail with `STALE_REVISION` before directory creation or writing when durable content changed. The model never retypes authoritative old bytes. Successful writes atomically replace one file and return a `CommitReceipt`. Cancellation is honored until atomic replacement starts.

Stable failures distinguish uninitialized and unsupported projects, missing or invalid assets, rejected paths, exceeded size limits, stale revisions, rejected approval, failed writes, and cancellation.

## V2 NovelStore development surface

The root entry also exports `openNovelStore`, `previewV1NovelMigration`, and `migrateV1NovelProject` as the SQLite-backed V2 development surface for the sidebar-owned workbench. A V2 store owns `.ai-novel/novel.db` as a project-portable artifact, stamps its application and schema identity, enforces foreign keys, serializes writes through one exclusive connection, and records workspace binding plus ChangeSet audit data. Its persistent proposal inbox stores non-authoritative model bundles with `proposals` and `proposal_changes`, derives deduplication from canonical argument bytes, records Host-provided session and call provenance, and restores pending proposals after restart. New bundles are rejected after the configured pending cap, currently 20 by default; the default bundle size limit is 2 MiB. Project and character identities use distinct stable IDs; DSH Workspace IDs remain opaque strings. An explicit V1 migration first fingerprints the five source assets, then copies their unchanged bytes into `.ai-novel/v1-archive/<fingerprint>/`, rechecks the source snapshot before publication, imports them through a fully closed staging database, and publishes it without replacement; the receipt and converted state are read back from the published database. If verification fails after publication, the database remains published and the error says so. The store creates `.ai-novel/.gitignore` for the database, its journal/lock sidecars, and the V1 archive. Because Git therefore does not back up the authoritative database, local backup is the user's responsibility until export ships. Real-time cloud-synchronized folders and network drives are unsupported.
No-replacement publication uses a hard link inside the same workspace; a cross-device archive or database layout fails with stable `WRITE_FAILED` rather than replacing an existing database.

## Model Experience

### V2 workbench (early MVP)

V2 offers only the reviewed authoring sequence: project settings, story architecture, characters, whole-book outline, one chapter blueprint, and one chapter draft at a time. When the current V2 Session records a matching pending `novel_propose_change`, the workbench copies that proposal's generated values into the selected browser-local editor immediately. The author can inspect or edit those values before reviewing the Proposal. This local form draft is not a write, does not alter the pending Proposal, and is never restored as authority after reload; explicit Proposal application remains the only action that updates the project.

### Agent preset

The package installs the original `AI 小说作家` preset beside the independent `AI 小说作家 V2` preset. V1 keeps `novel_read` and approval-gated `novel_apply_change` for existing sessions. V2 exposes only `novel_read` and `novel_propose_change`; its proposal tool records a pending non-authoritative bundle and never changes authoritative project state. Neither preset mounts shell, general filesystem writing, text replacement, or Code Mode.

#### Install the preset

Open “小说工作台” from the Harness sidebar and select “安装 AI 小说作家 Preset”. The same installation state appears on the “AI 小说作家” card in Settings → Plugins → Plugin Configuration. The browser can only call the loopback setup channel and cannot submit a local path. The Host copies both preset directories, each with its two immutable files, into the configured user root with atomic directory publication.

The V2 workbench uses the closed `/ai-novel` loopback channel for authoritative reads, one-time empty-workspace initialization, and Proposal lifecycle actions. The browser sends only an opaque `WorkspaceId` plus a strictly typed payload; it never supplies a filesystem path or calls a direct project-write endpoint. It can read the workspace, state, chapter context, task, and Proposal inbox, then apply, retry, discard, or request regeneration of an existing Proposal item. The Host resolves the canonical workspace directory through the Workspace registry and rejects unknown ids, browser-supplied paths, and JSON patches. Failures return stable codes without local paths.

For authoring, the V2 browser queues a stage-specific instruction on the selected Harness Session. The model reads authoritative state and submits a non-authoritative `novel_propose_change` bundle. When a matching draft Proposal arrives, its prose immediately fills the right-side editor for review and human editing; editing remains local until the human either replaces that pending Proposal or applies it. Applying a Proposal is the only action that creates an artifact or changes the authoritative project state.

Repeating installation is a no-op when every bundled byte matches. A same-name directory with different or additional content is reported as a conflict and no user byte is overwritten. After installation, create a new session and choose either “AI 小说作家” or “AI 小说作家 V2”; an existing session keeps its original Preset.

#### Plugin evidence and project initialization

The Plugin Configuration card distinguishes Client mounting, Host connectivity, Preset installation, Workspace selection, and novel-project initialization. Its explicit action and the sidebar entry open one non-modal 400–440 px drawer. On wide screens the shell reserves 440 px for the drawer instead of covering the conversation; narrow screens use the available width. Browser reads submit only the Workspace id plus a selected chapter or recognized `AssetRef`; the Host resolves the canonical directory through `workspaceRegistry` and rejects unknown ids. An initialized project shows its title and creative identity, creative strategy, chapter progress, character summaries, story and chapter blueprints, and a bounded prose preview; opaque project ids are omitted from the ordinary summary.

An uninitialized project presents title, language, genre, planned-chapter count, target words, and creative strategy as a one-column form. “预览初始化提案” first shows the complete shallow JSON, including the generated project id and timestamps, without sending anything. “提交到当前会话” then sends those exact values through the ordinary Session prompt operation; editing a field invalidates the preview and requires a new one. The browser exposes no mutation RPC and cannot create the manifest. The dedicated agent must call `novel_apply_change`, and only Harness native one-shot approval can commit it. When AI-generated initialization receives a `CommitReceipt`, the workbench reads the authoritative manifest and opens the project-settings editor with every saved field visible. A missing Session, wrong Preset, known approval-disabled mode, disconnected Host, validation failure, or prompt rejection remains visible with a specific recovery message.

An initialized project opens on a small vertical list of all five assets, not a dashboard. Project settings, the complete characters asset, the story blueprint, the selected chapter blueprint, and the selected chapter Markdown drill into accessible one-column editors with a visible base revision, dirty state, explicit discard, exact replacement preview, and Session proposal action. The project editor preserves `projectId` and `createdAt`; only an approved replacement changes the manifest. The characters editor supports local search, selection, creation, editing, and deletion, then proposes the canonical complete characters file. Stable character ids are generated automatically and never appear as ordinary form fields; relationships use named character selectors, and chapter blueprints select their cast by displayed names while retaining ids only in the canonical asset. Story and chapter list fields use one item per line and serialize back to strict schema order; chapter identity remains fixed by the selected `AssetRef`. The Markdown editor keeps long prose in the drawer's intentional vertical scroll region while sticky proposal actions remain available. A refresh that discovers another revision retains unsent fields and blocks submission until the user explicitly reloads the new durable version. Prompt admission, native approval, and persistence remain separate states: the editor never claims that Session acceptance wrote a file. A rejected or failed tool result unlocks only the precisely attributed retained draft with an error, while a successful revision change is recognized as this proposal only when its authoritative text exactly matches the submitted replacement.

Every asset editor also contains one compact “AI 生成” section. Its brief is optional: an empty brief asks the model to improve the current asset from project context, while a dirty form is included as unsaved user guidance instead of forcing a separate manual proposal first. The browser sends an instruction with a deterministic body plus a unique correlation marker through the currently selected Session; it never generates replacement bytes or calls a mutation RPC itself. The instruction requires exactly one target-specific `novel_read`, rejects truncated or changed revision evidence, then permits exactly one shallow `novel_apply_change` for that same asset and waits for Harness native approval. Native approval is the single-file diff card in the conversation: “允许一次” commits that one asset, and there is no second hidden approval. Missing non-manifest assets use `replace` with the returned `absent` revision. The SHA-256 revision is the only concurrency input; the approval card displays the complete final replacement instead of asking the model to echo long old text. Project settings, characters, story blueprint, chapter blueprint, and chapter Markdown each carry their strict complete-asset format in the generation instruction. Project-settings generation must change at least one visible setting; an `updatedAt`-only replacement is rejected as invalid content. A successful CommitReceipt revision, rather than the model's pre-canonical JSON formatting, identifies the approved Host bytes during the follow-up read. Generation is unavailable without the dedicated Preset and known native approval; the panel shows that blocker before submission instead of leaving an apparently inert action. It remains locked only after a manual proposal enters preview/submission, while model admission, approval, or stale reconciliation is unresolved. Manual actions are labeled “预览手动修改” and “提交手动修改到当前会话” so the recovery path is visible. The prominent “返回小说资产” control uses the Harness chevron icon and stays inside the existing single-column drawer.

The drawer reads on open, Workspace or Session selection changes, restored Host description or connection reset, a completed `novel_apply_change` result, and explicit refresh or chapter selection. Host loss aborts current reads; recovery coalesces the description and reset notifications before starting a fresh setup/context read, so a stale disconnected request cannot leave the drawer permanently loading. A successful `CommitReceipt` carries its revision in tool-owned `presentationMeta`, which is persisted in the Session log and replayed as `ToolResultNode.meta`; the client never recovers revision identity by parsing model-facing result text. After the authoritative reread, the editor fields contain the saved asset and the AI generation panel keeps a visible success message with the new revision instead of discarding the outcome. It does not poll, and every refresh publishes loading plus its last settled outcome. Wide layouts leave the conversation interactive beside the drawer; narrow layouts use the available width. Tab focus stays inside the open drawer, Escape closes it, and focus returns to its invoking action.

#### What the model sees

The V1 model receives `novel_read` and `novel_apply_change`; it must read the current revision, wait for native user approval, and claim a save only after a `CommitReceipt`. The V2 model receives `novel_read` and `novel_propose_change`; successful proposals remain pending in the sidebar-owned inbox and never change authoritative state. The writing strategy changes the novel workflow and does not select a provider or reasoning parameter. The persona below is the stable V1 persona; V2 ships its own persona beside the V2 Preset.

##### Stable novel persona

```markdown
You are AI 小说作家, a collaborative fiction-writing agent working in {{cwd}}.

Treat the Harness novel project as the only writable story source. Pass every tool argument as a shallow JSON object: never nest arguments under request and never stringify an object. Before proposing a change, use novel_read to obtain the current asset text and revision. Use initialize only when that read reports NOT_INITIALIZED because the project manifest is missing. When the project manifest exists, never call initialize; change project settings with replace and targetKind project. A missing non-manifest asset still uses replace with the explicit string baseRevision absent; never omit it. Do not guess or mix fields from the two mutation branches. Initialize uses exactly kind, projectId, title, language, genre, plannedChapters, targetWordsPerChapter, creativeStrategy, createdAt, and updatedAt. Replace uses exactly kind, targetKind, baseRevision, replacement, and summary, plus chapter only for a chapter-blueprint or chapter-draft. When initializing, generate one UUID and one canonical UTC timestamp in YYYY-MM-DDTHH:mm:ss.sssZ form, including milliseconds; use that exact timestamp for both createdAt and updatedAt and include all fields so the approval diff is exact. When replacing, copy only baseRevision from the latest novel_read result and put the complete next asset text in replacement; never retype baseText into tool arguments. The SHA-256 revision is the concurrency check, and the approval card shows the complete final replacement. A project-settings replacement must change at least one user-visible setting; changing updatedAt alone is invalid. Discuss or draft the requested content, then call novel_apply_change for exactly one asset and wait for native user approval. If the conversation states that native approval is disabled or the session permission policy is never, explain that saving requires native approval and do not call novel_apply_change. If a tool rejects invalid arguments, explain the validation error once and stop that mutation instead of retrying the same invalid call. Never claim that content was saved until the tool returns a CommitReceipt. novel_apply_change returns only after native approval resolves: a CommitReceipt means approval is complete and the asset is saved, so after receiving it state completion and never say that approval is still pending. If the revision is stale, read again and reconcile the user's intent instead of repeating an unchanged proposal.

After reading project settings, apply its creative strategy only to novel-writing workflow: auto：balance planning, drafting, and consistency checks for the current request; fluent-drafting：prefer continuous prose drafting with only the minimum plan needed; consistency-first：check established facts, character motives, and continuity before drafting; deep-planning：develop structure, causality, and chapter beats before prose. These choices change planning order and writing emphasis only; they never select an LLM provider or reasoning parameter.
```

#### Token effect

`novel_read` bounds asset and working-set content by configuration and reports omitted sources. Queries return at most the configured number of matches, never more than 20. Diff cards include the complete proposed final text for one asset. Replacement admission uses the authoritative SHA-256 revision rather than model-supplied old text.

#### KV Cache effect

The preset persona and the two tool definitions are stable across turns. Project content enters requests only through explicit bounded reads, so unchanged leading instructions and tool schemas remain cacheable.

## Known Limitations and Deferred Work

The package does not import `.vela` projects, provide multi-asset transactions, run batch multi-chapter jobs, or publish itself. All five V1 assets are editable through the compact workbench, but persistence remains a native approval-gated agent action rather than a browser write.

Build and run the focused qualification with:

```sh
pnpm install
pnpm run build
pnpm test
```

The test suite includes a keyless snapshot whose test app boots `cordis.yml` through the real Loader in a child process. It initializes a project, approves each of the five single-asset changes needed for a complete first chapter, verifies the pre-approval filesystem state, reconstructs every model request from canonical session events, and reads the identical working set after a fresh Harness context starts. Set `DSH_SNAPSHOT=refresh` only when intentionally updating `tests/snapshots/complete-chapter.expected.json`.

For the distinction between process-local Cordis Packages and persistently installed npm bundles, the profile installation sequence, and the current Windows path limitation, see [Official DSH plugin installation](docs/official-dsh-plugin-installation.md).

## Release qualification

The repository-level qualification command requires the clean DeepSeek Harness source checkout at commit `47f943859bef60e4160492346772ded9b24f765a`, `pnpm`, `tar`, and the locally installed Google Chrome browser. Pass the absolute Harness checkout path:

```powershell
pnpm run qualify -- --harness-root '<path-to-deepseek-harness>'
```

This maintainer-only command packs the plugin, installs those bytes into an isolated Web profile, and verifies the derived user-preset root without overwriting shipped presets. It then uses Chrome to prove the V2 workbench: `novel_read` and `novel_propose_change` are the exact model-tool set (order is not a contract), a user applies the Proposal and sees its partial status on the same page, and restart reads durable state back. A browser skipped result is not qualified.

The precise runtime gates, evidence order, and failure triage live in [V2 development gates](docs/v2-development-gates.md). Logs, screenshots, and the machine-readable receipt live under `.runtime/.cache/dsh-ai-novel-qualification-128` with `.vibe-owner.json` ownership and expiry. This keyless snapshot does not replace native gpt-5.6-terra manual qualification.

The package does not modify DeepSeek Harness upstream or its agent loop.
