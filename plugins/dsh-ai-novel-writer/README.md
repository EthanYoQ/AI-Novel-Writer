# AI Novel Writer for DeepSeek Harness

The `0.1.0` plugin preview is frozen. No short-term feature work is planned. This README supports existing users and maintainers. Development can resume only under a new, explicitly scoped plan.

The plugin adds a local novel workspace to DeepSeek Harness Web. It has its own project format and release. It does not open desktop projects. The desktop app's `1.2.0-Preview` release does not change this plugin's version or maintenance status.

[Desktop app](../../README_en.md) · [npm package](https://www.npmjs.com/package/@ethanyoq/dsh-ai-novel-writer) · [Installation guide](docs/official-dsh-plugin-installation.md)

## Install the plugin

Use a working DeepSeek Harness installation. The published package requires Node.js `^22.19 || >=24`.

1. Add the plugin to the Web profile.

```sh
dsh plugin --profile web add @ethanyoq/dsh-ai-novel-writer
```

2. Start the same profile.

```sh
dsh --profile web
```

3. Open 小说工作台 from the Harness sidebar.

4. Use the Preset installation action to install the bundled presets.

5. Create a new session and choose AI 小说作家 V2.

6. Select the workspace for your novel.

The repository's root package is a desktop application. Do not install it as a DSH plugin. For tarball installation, development setup, and the Windows path limitation, read the installation guide above.

## Write with the V2 workbench

V2 supports project settings, story architecture, characters, a whole-book outline, chapter blueprints, and prose. Work on one chapter at a time. It does not provide the desktop app's batch workflows or automated review process.

Use the workbench's project setup controls for an empty workspace. Complete the story architecture and characters before you prepare the outline and chapter blueprints.

For AI drafting, follow this sequence:

1. Select the stage or chapter you want to write.

2. Enter any instructions and request an AI draft in the selected session.

3. Inspect the generated values in the local editor.

4. Edit the values if needed and submit the revised proposal.

5. Review the Proposal inbox item.

6. Apply the proposal to update the project.

A Proposal is a pending change for human review. Receiving a proposal or seeing generated text in the editor does not save that text as project state. Editing the local form does not change the pending proposal until you submit the replacement.

The local form draft is not authoritative and does not become saved project state after a reload. Applied changes are stored in the project. The inbox retains pending proposals after restart.

If a proposal applies only partly, inspect its status before applying the remaining items. Failed items can be retried, discarded, or regenerated through the workbench. Do not assume that every item was saved because one item succeeded.

## Keep an existing V1 session

The package also installs the original AI 小说作家 Preset. Existing sessions keep their original Preset. To switch to V2, create a new session with AI 小说作家 V2.

V1 reads with `novel_read` and changes one file with `novel_apply_change`. The tool presents the replacement for Harness native one-time approval. A successful `CommitReceipt` means the approved file was saved.

V2 reads with `novel_read` and proposes changes with `novel_propose_change`. The model does not apply those proposals. Human application in the workbench changes project state.

Neither Preset includes shell access, general filesystem writes, text replacement tools, or Code Mode. Creative strategy controls writing order and emphasis. It does not select a model provider or reasoning parameter.

Preset installation does not overwrite a same-name directory with different content. Matching installations remain unchanged. If installation reports a conflict, inspect the existing preset before deciding what to keep.

## Store and back up projects

V1 stores settings and planning files under `.ai-novel/`. Its chapter prose is in `chapters/NNNN.md`. V2 stores its project database in `.ai-novel/novel.db`.

V2 uses stable project and character identities, a proposal inbox, and a change audit. Character identity is separate from the character's displayed name. The browser sends workspace identifiers, not local filesystem paths.

Back up the project folder yourself. The V2 database and its sidecars are excluded from Git by `.ai-novel/.gitignore`. A Git commit alone does not back up that database. Plugin project export is not provided.

Use a local workspace. Real-time cloud-synchronized folders and network drives are unsupported. The plugin does not import desktop `.vela` projects or synchronize them with desktop projects.

### Convert plugin V1 data for development

The exported `previewV1NovelMigration` and `migrateV1NovelProject` functions support an explicit plugin V1-to-V2 conversion. They are development APIs, not a desktop import feature.

Conversion archives the original five assets under `.ai-novel/v1-archive/<fingerprint>/` and checks the source again before publishing the staged database. It does not replace an existing database. A cross-device layout fails with `WRITE_FAILED`.

If validation fails after database publication, the error states that the database remains published. Inspect that state before retrying. The V1 archive is also excluded from Git, so keep an independent backup.

## Diagnose a blocked action

The workbench distinguishes client mounting, Host connection, Preset installation, workspace selection, and project initialization. Check the reported blocker before submitting another generation request.

If the saved revision changed while you edited a V1 file, the change fails with `STALE_REVISION`. Reload the saved version and reconcile your edits before submitting again.

If V1 native approval is disabled, the agent cannot save the change. Accepting a session prompt is not file approval. Wait for the native approval result and a `CommitReceipt` before treating the file as saved.

For V2, inspect the Proposal inbox and its item status. A model response alone does not prove that an application succeeded. Read back the project state after application.

Use [Issues](https://github.com/EthanYoQ/AI-Novel-Writer/issues) for reproducible errors and [Discussions](https://github.com/EthanYoQ/AI-Novel-Writer/discussions) for usage questions. Include the plugin version and selected Preset. Remove credentials and private prose before posting.

## Configure the bundle

The Host accepts `presetRoot`, an absolute user-preset directory. Its default is `$DSH_HOME/.agent-presets`, normally `~/.dsh/.agent-presets`. Invalid paths or limits fail during plugin loading.

The agent's `surface` setting defaults to `v1`. The bundled V2 Preset selects `v2`.

V1 read limits use these defaults:

- `assetBytes` is 512 KiB per asset.

- `workingSetBytes` is 512 KiB per working set.

- `queryMatches` is 20 matches. Configuration cannot raise it above 20.

V2 proposal limits use these defaults:

- `maxProposalBytes` is 2 MiB per bundle.

- `maxPendingProposals` is 20 pending proposals.

Reads report omitted material when limits apply. V1 writes compare the last-read SHA-256 revision and atomically replace one file. V2 proposals remain pending until human application.

## Find the developer entry points

The package has four entries:

- The root Host entry loads through `cordis.patch.yml`.

- `./agent` supplies the V1 agent tools.

- `./agent-v2` supplies the V2 agent tools.

- `./client` supplies the Plugin Configuration card and novel workspace drawer.

The root entry exports `openNovelStore` and the V1 conversion APIs. See the [Host exports](src/index.ts), [V1 Preset](presets/ai-novel-writer/agent.cordis.yml), and [V2 Preset](presets/ai-novel-writer-v2/agent.cordis.yml) for the exact interfaces and instructions.

The plugin does not modify DeepSeek Harness upstream or its agent loop. Shared dependencies keep their own licenses.

## Run development checks

Run these commands from the plugin directory with the package's configured pnpm version:

```sh
pnpm install
pnpm run build
pnpm test
```

The keyless snapshot test boots a real Harness Loader in a child process. It checks a V1 first-chapter sequence, approval boundaries, saved files, and state after a fresh context starts. It does not prove online model quality.

Set `DSH_SNAPSHOT=refresh` only when intentionally updating `tests/snapshots/complete-chapter.expected.json`. Review the resulting snapshot change.

## Release qualification

Qualification requires a clean DeepSeek Harness checkout at `47f943859bef60e4160492346772ded9b24f765a`, pnpm, tar, and locally installed Google Chrome. Supply the checkout's absolute path:

```powershell
pnpm run qualify -- --harness-root '<path-to-deepseek-harness>'
```

The command packs the plugin and installs those bytes into an isolated Web profile. It checks Preset installation, the exact V2 tools `novel_read` and `novel_propose_change`, human Proposal application, partial status, and durable state after restart. A browser skipped result is not qualified.

See [V2 development gates](docs/v2-development-gates.md) for evidence order and failure handling. Each run stores temporary logs, screenshots, and a machine-readable receipt under a task-owned `.runtime/.cache/` directory with `.vibe-owner.json` ownership and expiry.

The keyless snapshot does not replace manual qualification with a configured online model. Historical receipts apply only to their tested source and package.

## License and third-party notices

The plugin's original source uses the [MIT license](LICENSE). The desktop app remains separately licensed under GPL-3.0. No GPL desktop source is included in this npm package.

Read [Third-party notices](THIRD_PARTY_NOTICES.md) for dependency license boundaries. Installing the plugin does not change the licenses of DeepSeek Harness or Cordis.
