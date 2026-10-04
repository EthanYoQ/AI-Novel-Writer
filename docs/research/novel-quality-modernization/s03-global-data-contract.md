# S03 global data migration domain

Dependencies: S02 `d72c13db638f1f2d87db3230e985411566139fca`, F01 `e2af35966adae4754b18ac7553544a618fa3dc34`. Domain owner covers the locator, global generation migration, existing config/app-data/MCP consumers, SkinService startup snapshot and dedicated fixtures. Main/IPC/preload/renderer startup integration belongs to the root integrator.

## Startup interface

`resolveGlobalDataRoots(userData, appData, env?, home?)` resolves names without reading author files or creating directories. `AI_NOVEL_LEGACY_SOURCE_HOME` selects the legacy source; `AI_NOVEL_VELA_HOME` is its compatibility alias only. `AI_NOVEL_APP_DATA_HOME` selects the canonical target. The legacy default is `home/.vela`; the canonical default is `app.getPath('appData')/ai-novel-writer`, as required by the frozen plan. Main supplies Electron's actual appData explicitly; the locator does not guess platform directories. Pre-admission live bindings use an invalid filesystem sentinel. Existing Electron userData, partition, file origin and application single-instance identity stay unchanged. A canonical/userData overlap, including a development naming collision, is rejected before writes.

After holding the existing application single-instance lock, call `runGlobalDataMigration({...roots, exclusiveAccess: true})`. A blocked result contains only a fixed safe code. A ready result contains the main-only dataRoot and generation plus `legacySourceIgnored` and `preservedUnknownCount`. Only `activateGlobalData(result)` on an actually admitted result activates the live config/model/recent-projects locators. It rejects a fabricated ready object. All existing imports use these live bindings; no fallback opens the old source for ordinary reads/writes.

Initialize the existing singleton `skinService` after activation, then call `getStartupSnapshot(globalGeneration)`. The snapshot throws on uninitialized, unreadable or corrupt state. The compatibility initialize method can return safe Classic on failure, so its return value alone is **not** readiness evidence. Snapshot `skinRevision` is a durable manifest stateRevision, initially zero for old manifests, incremented only on successful main writes and preserved across restart. `backgroundSkin` remains main-owned.

The integrator must combine successful global migration and skin snapshot before publishing MainReady. F01 then reads the skin snapshot, migrates its own renderer JSON and acknowledges readback. Main must validate sender/main frame/origin, storage key, profile revision, generation and current skin revision. This domain does not manufacture renderer acknowledgement or grant project write permission.

`legacySourceIgnored` means the old root exists and is no longer an input after cutover. It does **not** mean a later change was detected. No credential-bearing source hash is stored. The appropriate user notice is that the old source is retained and later changes require explicit import. `preservedUnknownCount` counts retained, non-imported top-level entries across legacy and preexisting flat canonical roots, including the explicitly retained categories below. Actual display of that notice is a central UI integration gate.

## Object disposition

| Object | Disposition and authority |
| --- | --- |
| config.json + models.json | One staged generation; exact bytes retained, IDs preserved, duplicate IDs and absent default/default-embedding references block. Same-ID differing apiKey yields only GLOBAL_MODEL_CREDENTIALS_DIFFER, without ID, key or key digest. No automatic merge or conflict overwrite. |
| config.updatePreferences | Preserved in the same config bytes; subsequent update service writes use the admitted generation. |
| recent-projects.json | Preserved privately as navigation data; not a transferable filesystem grant. |
| mcp_config.json | Preserved privately with structural validation; migration never starts commands or opens endpoints. |
| prompts | Raw files retained; JSON must parse as an object; templates are never rewritten. |
| skills | Raw files retained without executing them. |
| skins | Manifest and image bytes retained; structural dimensions/revision/reference checked before commit; native decode and usable startup snapshot must still succeed before MainReady. |
| logs / metadata / update directories | Backup-only in their original roots. No current product writer was established for arbitrary contents in these shared legacy directories; they are not silently imported, executed or deleted. Known update preferences are covered above. |
| Electron updater state / renderer storage | Existing userData stays in place; no LevelDB parsing, partition change or automatic cache copy. |
| Other unknown shared files/directories | Retained untouched, counted by existence without traversing contents. |

Known required assets containing symlinks/junctions or unsupported file types block before content reads. Roots are checked for links and intersection. Unknown entries are preserved without traversing their contents. Product project DB, LanceDB, DSH and author manuscripts are outside this global lane.

Independent review reproduced a prepared-staging hardlink that could alias userData. The repair rejects multi-link files in source/staging/installed content and journal/receipt reads. Staging writes now use exclusive temporary files and atomic replacement, never truncation of the retained destination inode. Actual hardlink fixtures cover retained staging, receipt aliasing, and a link inserted after inspection; source and userData remain byte-for-byte unchanged.

## Commit and recovery

The target contains `.migration/journal.json`, `.migration/receipt.json` and `generations/<id>`. Preparation happens only after source/config validation. Objects are copied into `<id>.staging` with flushed file writes, then checked by exact byte comparison and domain validation. The verified staging is renamed to the generation directory; only a completed receipt makes it available for activation. Config and models therefore use one locator generation.

Prepared staging can retry its journal-owned writes. Verified staging or an installed generation must still match the source on recovery before completing the receipt; a changed verified source blocks. Unknown half-generations and conflicting preexisting roots block. Neither source is deleted or renamed by this global migration.

After a completed receipt, current canonical data is authoritative. Later source corruption/changes are ignored and never reimported. Missing committed objects, corrupt JSON or invalid receipt/generation block instead of creating defaults. Receipts contain generation, phase/category counts and required logical object names; no credential hashes, machine paths, source payloads or raw errors are included.

File writes are fsynced before same-volume rename. Directory fsync is used where Node supports it; Windows has no Node directory-fsync equivalent, so restart uses journal/physical-state verification. These deterministic interruption tests do not claim hardware power-loss or filesystem failure qualification.

## Evidence

The dedicated suite exercises legacy-only/canonical-only/empty installs, all seven migrated object write checkpoints and prepared/verified/installed/receipt interruptions, corrupt objects, missing model references, duplicate IDs, credential conflict, source change after verification, missing committed objects, unknown target state, root collision, required-asset junctions, forged activation, legacy changes after receipt and current canonical edits.

Every new migration fixture uses three synthetic sibling roots. Source and userData bytes are compared unchanged; a filesystem write monitor verifies migration writes remain entirely inside the synthetic canonical target. Existing MCP/prompt/Skill/config corruption tests now obtain their test roots through the actual coordinator instead of treating the old environment variable as a writable destination. No migration was run on real author configuration.

Commands: focused `vitest run` over global-data-migration, config-utils, skin-service, update-preferences-store, release-skin-smoke, app-data-controller, writing-skill-app-data, issue-88-global-prompt-persistence, config-controller-corruption, llm-controller-config-corruption and mcp-manager tests; plus `pnpm run typecheck`. Actual test counts and final file hashes are provided in the parent handoff. Packaged Electron startup, real main acknowledgement, notice presentation and full product qualification remain integrator gates.
