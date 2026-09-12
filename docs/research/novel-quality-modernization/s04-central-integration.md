# S04 central integration

Dependency: S03 `003dc9b36a081febcb3def739e0474ae8c8d46d9`, with production global-root correction `2a0077c`.

## Installed scope

Canonical projects store a strict identity manifest in `.ai-novel/project.json` and SQLite in `.ai-novel/project.db`. Manifest schemaVersion, storageVersion and SQLite user_version are distinct contracts. Only explicit new-project creation creates a database. Ordinary opens verify a physical read snapshot before opening a writable native handle; session fencing follows verification and does not rerun schema/data normalization.

`desktop-registry.ts` is the single installed business registry. M00 targets user_version 1; versions 2–6 remain reserved for their owning slices. The current recognized source catalog comes from the unchanged baseline DDL in an empty in-memory reference, with and without the two formerly lazy blueprint tables. Exact sqlite_master DDL includes tables, indexes, triggers and views. Unknown variants and newer versions reject; no author schema is learned or accepted dynamically. Target baseline remains the signed 35-table/356-field set.

The old database function was extracted to one `baseline-schema.ts` source. New empty databases may initialize its full baseline. M00 on an accepted existing source executes baseline/table DDL only, preserves all existing nonempty rows and cached values, and never invokes the old data backfill or session fencing. `baseline-blueprint-schema.ts` is likewise shared with the existing repository, not a second DDL copy.

## Physical preservation

A real WAL test proved that SQLite `readonly: true` can alter the original SHM read marks. The implementation therefore never connects the original source: it copies DB/WAL/SHM/journal through filesystem reads, compares source and copy hashes, opens only that copy with readonly/fileMustExist, and uses SQLite's native backup API to populate staging. Source hashes are checked again before success. The coordinator separately owns writer exclusion, complete legacy backup and physical cutover.

Every nonempty non-internal table contributes sorted exact row values to the private domain comparison; empty tables may be added by M00. This includes author prose, opaque receipts, lease values and deliberately stale cached counts. These local integrity digests are not portable/public author-data receipts. Staging runs the single migration transaction, is verified, checkpointed and file-fsynced through a writable non-truncating descriptor on Windows, and all native handles close before returning. Windows directory flush and hardware power-loss qualification are not claimed.

Read snapshots use owned short scratch directories under the existing LOCALAPPDATA (or platform temp fallback), so a packaged app does not require a writable installation directory. Each has `.vibe-owner.json`, source project, creation time, 24-hour TTL and cleanup command; successful and failed completed operations remove their own snapshot directories.

## Business consumers and validation boundaries

The main-process project locator activates only after the actual SQLite verifier and canonical identity checks. It has no `.vela` fallback, rejects dual roots/incomplete migration receipts and is revoked when its database session closes. Vector storage, prompt/Skill/recovery paths and generated-file trash resolve canonical storage. Ordinary knowledge-base access rejects pending old JSON migration instead of launching it as a read side effect. The release vector smoke creates two real canonical synthetic projects and uses the same admission path.

Focused real-native checks cover WAL byte preservation, M00 domain preservation, unknown column/trigger/version rejection, missing/existing-file refusal, create/open separation, ordinary reopen without cached-count backfill, post-verification lease fencing and locator revocation. Initial focused tests exposed SHM writes; the initial Windows fsync attempt using a read-only descriptor also failed, and was corrected to non-truncating r+. Original failure logs remain private alongside subsequent passing runs.

Legacy partial-schema regression suites explicitly exercise the extracted normalization helper with test-owned repository handles. They do not claim those historical layouts are accepted by the production registry. Separate production-entry assertions and canonical tests cover fail-closed unknown layouts and normal new-format use. No old-binary, author-project in-place migration, cross-process exclusion or abrupt-power-loss qualification is claimed by these tests; only synthetic fixture permits currently reach the physical converter.

## Integrated verification

The complete Node run passed 307 files, 2,945 tests, with nine existing skips. The complete Chromium run passed 52 files and 326 tests. Type checking, lint and translation coverage passed. Initial failures from legacy prompt paths and a browser binding-path expectation were fixed without removing the original business assertions; failure logs remain retained. An independent installer timing test took 20,560 ms against a 20,000 ms limit; this failure remains separate from the passing complete Node run.

Real Electron acceptance exercised three synthetic project scenarios through public IPC: canonical create/save, process restart/reopen with identical project identity and author text, and rejection of an unqualified legacy project with unchanged original bytes. Four global startup scenarios also passed on the final build. Neither script made provider requests.

Desktop execution exposed two additional defects. An explicit canonical override still triggered an unnecessary OS appData query, which threw in the isolated Windows profile before migration ran. The default locator is now lazy: an explicit override avoids that query; otherwise Electron appData remains mandatory, is validated, and never falls back to home. The focused main/global regression passed 45 tests, with an independent related set passing 50. The project error handler also overwrote its actionable migration message with the internal exception; the corrected public response passed 34 controller tests and the actual desktop rejection scenario. Both failed desktop attempts and the failed message assertion remain recorded. Earlier complete test counts precede these narrow corrections; their focused regressions and the final desktop build validate the corrections separately.

Independent review covers domain migration, native vector preservation, renderer paths and central integration at recorded file hashes. Baseline plan files remain byte-identical. The Node ABI was restored after desktop execution. This is S04 scoped implementation evidence; it does not qualify author-project upgrades, final model quality, portable restore, supported old binaries or release packages.
