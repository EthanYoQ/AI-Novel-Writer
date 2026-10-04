# S08 domain evidence

Dependency: `5c5069673af4d2ef3f8c3e57ac9133e96a898255`. Domain and central M02 registration implemented, pending final independent review. No model calls, real author project migration, ABI change, commit or push.

## Storage and authority

M02 is `2 -> 3`, owner S08, installed only by the central registry. `applyM02CharacterIdentity` requires an existing transaction and captured SQLite handle. It derives the replacement characters DDL from the centrally recognized source schema, preserving every original column, and compares every original value before the transaction can commit. The name primary key becomes a stable generated ID; display names may repeat. `legacy_key`, immutable original-row evidence and dynamic `cs_provenance` remain available. No manuscript, blueprint JSON or old relationship string is rewritten.

Six auxiliary tables hold immutable legacy origins, scoped/versioned aliases, unresolved proposals, approval receipts, ID relationships, and identity revision/legacy count. Static source provenance remains legacy until an explicit main-approved change. Generated adoption retains generated source and model revision; edited fields gain their own source and approval reference without overwriting dynamic provenance.

All old structured relationship strings and blueprint name references become proposals with raw values, source identity/hash and candidate ID sets. Even a unique name has no inferred source authority. Free-text relationships are retained, not parsed into invented facts. Existing recovery candidates remain in their original stores; a recovered name without matching original source scope cannot resolve to a newly reused name.

`verifyM02CharacterIdentity` checks foreign keys, immutable origin hashes and count, original legacy keys, proposal candidate identity consistency, resolution/approval pairing and alias revision ranges. It allows later legitimate author edits. The central registry must additionally verify the exact structural fingerprint before/after migration and on reopen.

## Main integration seam

- `createM02Migration({database, verifyKnownSchema})`: central adapter supplies its captured DB; no second connection/registry.
- `commitCharacterIdentities(db, request, authorize)`: default authorization rejects. Existing changes require IDs; approved creations receive IDs inside the transaction. New-creation selection keys can reference each other only within that approved transaction. Relations persist IDs and approval-time display snapshots. Explicit identity resolution maps old structured relations in the same transaction. Retiring a character retains its original record.
- `readCharacterIdentitySnapshot(db)`: returns current and retired records, aliases, ID relationships and unresolved proposals for later product integration.
- `CharacterRepository.getById`; legacy `getByName(name, sourceKey)` requires unique current scoped evidence. `resolveScopedCharacterIdentity` provides resolved/ambiguous/unresolved results with version/project bounds. The original S01 pure contract helpers remain unchanged.
- On M02, old roster commit/upsert/saveAll/delete/updateState raise `CHARACTER_ID_WRITE_REQUIRED`; no name-based merge is silently retained. Old schema fixture behavior remains available solely for historical regression.

S09/UI/controller/IPC migration is not part of this domain delivery. Those consumers need explicit typed ID and approval adapters before they can write through the new API. No claim is made that all author-facing entry points have been migrated. Shared portable field allowlists also require central registration for the new columns/tables.

## Verification

Six focused suites: 97 tests passed, including the existing S01 novel contracts and 39 historical character repository regressions. New cases cover source-scoped ambiguity, same display names, name swaps, unknown legacy blueprint names, old-candidate source mismatch, repeated approval, generated source retention, transaction rollback, identity/relationship creation in one transaction, historical display snapshots, explicit legacy-relation approval, immutable-origin damage and real file close/reopen preserving IDs. These are deterministic synthetic fixtures.

Owned ESLint passed. Typecheck passed. Central lane integration is documented separately in s08-schema-lane-evidence.md; full-suite qualification has not been run for M02. No hardware power-loss or external concurrent-writer qualification is claimed.

Independent review corrections: runtime approval action/source matrix rejects unknown origins and incompatible adoption labels; scoped resolution rejects empty identities/scopes and non-integer or non-finite version evidence. Reopen verification applies matching persisted alias/identity-version checks. Synthetic counterexamples verify no approval or character is written on rejection.

Central integration additionally uses bigint-safe legacy copy and supplies the temporary main source guard on the old pre-M02 roster commit. See the separate central evidence and its retained intermittent recovery failure.
