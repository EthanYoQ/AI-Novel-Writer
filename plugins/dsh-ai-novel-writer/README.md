# AI Novel Writer for DeepSeek Harness

This out-of-tree bundle adds a revisioned, local-first novel project format to DeepSeek Harness. Its dedicated agent sees only `novel_read` and `novel_apply_change`; every mutation is presented as a one-file diff and passes through Harness native one-shot approval before execution.

The V1 project is independent from the desktop application's `.vela` format. It stores a manifest and structured planning assets under `.ai-novel/`, with chapter drafts under `chapters/`. Model inputs use discriminated asset references rather than local paths, writes compare the last-read SHA-256 revision, and commits use atomic replacement.

The package ships three plugin entries:

- the root Host entry, loaded by `cordis.patch.yml`;
- `./agent`, mounted only by the bundled `ai-novel-writer` preset;
- `./client`, currently a no-op browser entry so Harness can discover the declared web client.

## Configuration

The agent entry accepts `assetBytes`, `workingSetBytes`, and `queryMatches`. Defaults are 512 KiB per asset, 512 KiB per working set, and 20 query matches. Invalid limits fail during plugin loading.

## Project files

`.ai-novel/project.json` identifies the project and stores its writing settings. Character, story, and chapter-planning JSON files use strict schemas and canonical two-space JSON with LF line endings. `chapters/NNNN.md` stores chapter prose. Missing non-manifest assets are returned as explicit empty assets with revision `absent`; a `.vela` directory is neither read nor modified.

Each non-empty asset revision is the SHA-256 digest of its normalized UTF-8 bytes. Replacement requests identify one `AssetRef`, include the last-read revision and original text, and fail with `STALE_REVISION` before directory creation or writing when durable content changed. Successful writes atomically replace one file and return a `CommitReceipt`. Cancellation is honored until atomic replacement starts.

Stable failures distinguish uninitialized and unsupported projects, missing or invalid assets, rejected paths, exceeded size limits, stale revisions, rejected approval, failed writes, and cancellation.

## Model Experience

### Agent preset

The included `AI 小说作家` preset mounts the novel persona, agent instructions, and `./agent`. It does not mount shell, general filesystem writing, text replacement, or Code Mode.

#### What the model sees

The model receives `novel_read` and `novel_apply_change`. Its persona requires reading the current revision before proposing one asset change, waiting for native user approval, and claiming a save only after a `CommitReceipt`. The writing strategy changes the novel workflow and does not select a provider or reasoning parameter.

##### Stable novel persona

```markdown
You are AI 小说作家, a collaborative fiction-writing agent working in {{cwd}}.

Treat the Harness novel project as the only writable story source. Before proposing a change, use novel_read to obtain the current asset text and revision. When initializing a project, generate one UUID and one ISO-8601 timestamp, use that timestamp for both createdAt and updatedAt, and include all three values in the proposal so the approval diff is exact. Discuss or draft the requested content, then call novel_apply_change for exactly one asset and wait for native user approval. Never claim that content was saved until the tool returns a CommitReceipt. If the revision is stale, read again and reconcile the user's intent instead of overwriting. The creative strategy changes the writing workflow only; it never selects an LLM provider or reasoning parameter.
```

#### Token effect

`novel_read` bounds asset and working-set content by configuration and reports omitted sources. Queries return at most the configured number of matches, never more than 20. Diff cards include the proposed before and after text for one asset.

#### KV Cache effect

The preset persona and the two tool definitions are stable across turns. Project content enters requests only through explicit bounded reads, so unchanged leading instructions and tool schemas remain cacheable.

## Known Limitations and Deferred Work

The package does not install the preset into a user profile, expose Host read RPCs, render a context window, import `.vela` projects, provide multi-asset transactions, or publish itself. The shipped client entry has no interface.

Build and run the focused qualification with:

```sh
pnpm --filter @ethanyoq/dsh-ai-novel-writer build
pnpm --filter @ethanyoq/dsh-ai-novel-writer test
```

The package does not modify DeepSeek Harness upstream or its agent loop.
