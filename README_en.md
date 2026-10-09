<p align="center">
  <img src="docs/assets/readme/ai-novel-writer-logo-transparent.png" width="104" height="104" alt="AI Novel Writer logo" />
</p>

# AI Novel Writer

**English** | [中文](README.md)

AI Novel Writer is a novel writing app for Windows and macOS. You can organize story details, plan chapters, create drafts, and review and revise them. Projects stay on your computer. You configure the AI model.

## Try 1.2.0-Preview

This is a public test release with a new writing interface, project storage, and recovery process. The maintainers plan to fix reported problems before preparing the stable release. There is no fixed date for the stable release.

[Download Preview or a stable release](https://github.com/EthanYoQ/AI-Novel-Writer/releases) · [Read the changes](.release/notes/v1.2.0-Preview.md) · [Report a problem](https://github.com/EthanYoQ/AI-Novel-Writer/issues)

On the Releases page, select the version labeled `1.2.0-Preview`. The `Pre-release` label identifies a test release. To use a stable version, choose a release without that label.

Back up important work before testing. AI can miss story details, make incorrect review judgments, or produce unsuitable text. A completed generation does not mean the chapter is ready. Check the text before finalizing it.

## What you can do

- Start with a story idea, then organize the premise, characters, and world setting.

- Turn an outline into chapter blueprints. Each blueprint describes the chapter's goals, conflicts, and events.

- Generate a draft from a blueprint. Read the review report, choose the issues to address, then revise and finalize the chapter.

- Write consecutive chapters with a batch task. Keep drafts for review or select automatic finalization.

- Save or transfer a complete project archive. Export Markdown or plain text when you need to deliver the manuscript.

The app does not include model accounts, model credits, online publishing, or a reading community. Cloud models require your own account and credentials. Your model provider may charge for requests.

## Install the desktop app

Download the file for your system from the [official Releases page](https://github.com/EthanYoQ/AI-Novel-Writer/releases). Check that the version in the filename matches the release you selected.

### Windows x64

1. Download `ai-novel-writer-setup-<version>.exe`.

2. Run the installer.

3. Start AI Novel Writer.

The Windows installer is not code-signed. SmartScreen may show an unknown-publisher warning, and system policy may block execution. If a warning appears, check the download source and the release notes first.

### macOS

1. For an Apple Silicon Mac, download `ai-novel-writer-mac-arm64-<version>-installer.dmg`.

2. For an Intel Mac, download `ai-novel-writer-mac-x64-<version>-installer.dmg`.

3. Open the matching DMG and drag the app to Applications.

4. Start AI Novel Writer.

The macOS packages use ad-hoc signatures. They have no Developer ID signature and are not notarized by Apple. Gatekeeper may warn about or block the app.

After you verify the source, follow your system's instructions to allow the app under Privacy & Security in System Settings. Read the selected release's notes for its package and security details.

### Install later updates

Stable update checks exclude Preview releases. To try Preview, download and install it manually from the Releases page.

On Windows, the app announces a stable update first. The download starts only after you choose to download it. When the download finishes, you decide when to restart and install.

On macOS, the update action opens the official Release page. Download the DMG for your Mac yourself. The app does not replace the macOS program internally.

## Start with chapter one

Prepare a working generation model first. The interface language and the project's writing language are separate settings.

1. Open Settings and select Generation models.

2. Add a model with its provider address, model name, and required credentials.

3. Save the profile and select it as the default generation model.

4. Return to the home page and choose New project.

5. Enter your story idea, writing language, and chapter goals.

6. Complete the premise, characters, world setting, and plot outline.

7. Open Chapter blueprints and create a blueprint for chapter one.

8. Use the blueprint's writing action to generate a draft.

9. Open the draft and run AI review.

10. Check the report, select the issues to address, and run revision.

11. Check the revised text and finalize the chapter when you approve it.

Finalization saves a finished chapter within the project. It does not publish your work to a website. To deliver the manuscript, use Export and select Merged Markdown, Chapter Markdown, or Plain text.

## Configure your model

The app supports the OpenAI-compatible protocol and the native Gemini protocol. OpenAI-compatible means an interface compatible with Chat Completions. A custom address must still support the protocol you select.

Presets include OpenAI, DeepSeek, Ollama, and NovelAI. After selecting a preset, check its address, model name, and account permissions. A different URL and key do not make every service compatible.

If the endpoint provides a model list, you can fetch it in Settings. Models support different capacities and parameters. The output limit is a request setting. It does not guarantee that the model will produce that amount of text.

If the input exceeds the model's available capacity, the app rejects the request with an error. Choose another model or reduce the material for that request. A high output setting does not prove model capacity.

### Use local Ollama

Prepare the model in Ollama first, then use these settings. Enter the name of a model that you have installed locally.

```text
Provider: Ollama
Protocol: OpenAI-compatible
Base URL: http://127.0.0.1:11434/v1
API Key: may be blank
Model: your local model name
```

Use `/v1` for an embedding model too. Ollama's `/api` path is its native interface. It is not the path for this app's OpenAI-compatible requests.

### Use NovelAI

The NovelAI preset uses `https://text.novelai.net/oa`. Enter your Persistent API Token and a model name available to your account.

This preset has minimal compatibility support. The maintainers have not verified a complete writing workflow with a real NovelAI account. Check the provider's documentation and responses for account permissions and interface differences.

## Continue a long novel

Outline and blueprint actions plan five chapters by default. You can select one to ten chapters per action. This is an operation limit, not the project's total chapter limit. After one range finishes, continue with the next range.

Planning length is a soft target. Complete results remain available even when they exceed the target. If prose remains above its target length, the app warns you instead of discarding complete text solely because it is too long.

For the next chapter, the app includes the complete text of the immediately preceding chapter. It selects relevant material from earlier chapters. Requests still depend on model capacity, so there is no guarantee that every piece of material can be sent.

A batch writing task handles one to ten chapters and supports pause and cancel. Select Generate review drafts if you want to inspect chapters individually. Automatic finalization does not guarantee correct model output.

To require a detail in a specific chapter, add a separate line to character notes or the world setting:

```text
【第3章必现】Show the main character handing the key to their companion.
```

Keep the marker syntax above. Review looks for evidence of the requirement in that chapter's prose. An item marked for verification has not passed. Check the source text and decide whether to send the issue to revision.

When a blueprint proposes a new character, you can create a character, link an existing identity, or leave the proposal unresolved. A renamed character or a shared name does not establish identity. Check the proposal before confirming it.

## Handle a failed task

If generation, review, or revision fails, inspect the candidate text retained with the task. Use the available recovery or save action. A candidate is not the same as a saved draft or finalized chapter.

If the source blueprint or draft has changed, an older candidate may no longer be eligible for continuation. Check the current version and the candidate's source before acting. Recovery does not replace an independent backup.

## Keep old projects and backups

### Import a v1.0.0 or v1.1.0 project

Import a complete copy of the old project into the new version. Import does not call AI to reconstruct your story details. It does not convert the old project in its original folder.

1. Save the project in the old version.

2. Close the old app and any editor or sync tool that can change that folder.

3. On the new app's home page, choose Import legacy project copy.

4. Select the old project folder and a separate new folder.

5. Keep the old folder unchanged during import.

6. Check the manuscript and creative material after import finishes.

The old folder remains. The two projects save independently after import, and later edits do not sync automatically. If import reports missing or damaged material, address the problem before treating the import as successful.

### Save a complete project archive

1. Open the project.

2. Open Project backup in Settings.

3. Choose Export local archive.

4. Save the archive to a separate backup location.

A complete archive retains prose, history, and creative material, with file and manifest checks. Restore creates a separate new copy. A manuscript export is for reading or delivery. It does not replace a complete project archive.

### Use WebDAV backup

If you have a WebDAV service, configure its account in Project backup and bind the current project. Then upload a project archive manually, or download an existing backup and restore a new copy.

WebDAV is not live collaborative editing or automatic two-way sync. Upload sends the complete project archive to the server you configure. You manage the service account, storage space, and access permissions.

## Where your data goes

Prose, characters, blueprints, and creative records stay in the local project folder. Imported reference material also stays locally. Material selected for a generation request goes to your configured model service with the prompt.

For a local model, requests go to the local or LAN service you configure. For a cloud model, prompts and relevant prose go to that provider.

Model credentials and app preferences stay in the system's application data folder. The new version uses these default roots. Active configuration files are in the current data subfolder within that root.

- Windows uses `%APPDATA%\ai-novel-writer`.

- macOS uses `~/Library/Application Support/ai-novel-writer`.

The old `~/.vela` data remains after the upgrade reads it. Do not share a `models.json` file that contains API keys. Do not attach credentials or complete private work to a public issue.

Reference material supports full-text search. Vector search requires a separate embedding model. Writing Skills and prompt templates can add guidance for each stage. They do not guarantee output quality.

## Get help and report problems

Use [Discussions](https://github.com/EthanYoQ/AI-Novel-Writer/discussions) for usage questions. Use [Issues](https://github.com/EthanYoQ/AI-Novel-Writer/issues) for errors and feature requests. Search existing reports before submitting one.

For a Preview problem, include the version, operating system, model service, and steps to reproduce it. Describe the expected and actual results. Hide credentials and private text in screenshots.

Read the [contribution guide](CONTRIBUTING.md) before contributing code. Start with the [documentation index](docs/README.md) for development, domain rules, and architecture documents.

## DeepSeek Harness plugin

This repository also contains the separate `@ethanyoq/dsh-ai-novel-writer` plugin. Its `0.1.0` preview is frozen. The plugin does not read desktop projects and does not replace the desktop app.

If you use DeepSeek Harness Web, install the plugin with:

```sh
dsh plugin --profile web add @ethanyoq/dsh-ai-novel-writer
dsh --profile web
```

Open the novel workspace and install the AI 小说作家 V2 Preset. Select that Preset in a new session. AI proposals first fill a local form. Project state changes only after you review and apply a Proposal.

[Plugin documentation](plugins/dsh-ai-novel-writer/README.md) · [Installation guide](plugins/dsh-ai-novel-writer/docs/official-dsh-plugin-installation.md) · [npm package](https://www.npmjs.com/package/@ethanyoq/dsh-ai-novel-writer)

Do not install the repository's root package as a DSH plugin. The desktop app and plugin have separate releases and project formats.

## Historical interface image

The image below is a promotional montage from before V3. It preserves project history. The 1.2.0-Preview release uses the V3 interface, with different layouts and controls. Do not use this image to locate current actions.

<details>
<summary>View the historical English image</summary>

![Historical English montage, not the 1.2.0-Preview interface](docs/assets/readme/hero-en-v2.png)

</details>

## License

The desktop app uses [GPL-3.0](LICENSE). The DeepSeek Harness plugin uses its separate [MIT license](plugins/dsh-ai-novel-writer/LICENSE).
