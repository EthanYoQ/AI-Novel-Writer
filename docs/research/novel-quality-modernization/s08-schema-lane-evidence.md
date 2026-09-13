# S08 central schema lane evidence

Dependency: `5c5069673af4d2ef3f8c3e57ac9133e96a898255`. M02 is installed by the existing desktop registry, using its captured `SqliteSchemaAdapter.database`. Current schema is 3; exact recognized schema 1 and 2 remain upgrade sources. No second registry, connection or relaxed fingerprint exists. The locator already delegates to the upgrade seam and needed no source change.

The schema catalog is generated from the checked-in baseline, M01, then the same M02 function in an isolated memory transaction. Actual schema fingerprints:

- schema 2: `dead9cdfaeaed25acc48d904373ae1c1b23c0d92e6f648e1583071cbe1da2784`
- schema 3: `c725287a1db818a59e2179b622b1e60d46dc2fe8f7b006c3d08e5dbff1ee8684`

`backupProjectSqlite` and `upgradeProjectSqlite` capture the actual pre-migration table/column list and compare all its row values after migration. This includes character raw relationship strings, legacy provenance and every non-character table. SQLite 64-bit integers are read, copied and compared as bigint; the synthetic `9007199254740993` case guards against Number rounding. M02's new evidence is separately validated by its domain verifier and the exact target fingerprint.

The current `domain` remains the complete current database evidence. Schema 3 additionally returns `preIdentityDomain`, excluding only the five M02-added character columns and six M02 tables. The physical converter requires this old-fact projection for pre-3 to 3 conversions, then still compares the entire target evidence object against a fresh verifier result. Missing old projection and mutated current domain both block before canonical cutover. Current-schema backups continue comparing the full actual source table/column set.

Read-only probe and verification connect only to the existing safe physical copy and enable connection-local foreign-key checking. DB/WAL/SHM source bytes remain unchanged in the real WAL test. Unknown source structure and malformed same-version identity evidence refuse admission. An injected structurally valid migration that changes non-character prose rolls back with schema 2 and original file bytes intact.

## Portable field registration request

This is an actual SQLite introspection delta. Portable policies remain assigned to the central owner; no frozen S01 document was edited.

| Table | Added fields |
| --- | --- |
| characters | character_id, legacy_key, static_provenance, identity_revision, retired |
| character_aliases | character_id, name, source_key, valid_from, valid_through |
| character_identity_approvals | operation_id, payload_hash, receipt_json |
| character_identity_meta | id, revision, legacy_count |
| character_identity_origins | character_id, source_key, original_row_json, original_hash |
| character_identity_proposals | proposal_id, owner_character_id, source_key, source_hash, raw_value, candidate_ids_json, resolved_character_id, approval_id |
| character_relationships | relationship_id, source_character_id, target_character_id, relation, source_display_snapshot, target_display_snapshot, provenance_json, approval_id |

The old name column loses its primary-key constraint; its original values remain. Original-row evidence is author data, not a public diagnostic payload. Approval/provenance projections must retain origin while applying the portable SourceRef/epoch/non-replay rules; original opaque receipt hashes must not certify a redacted transfer.

## Verification and boundary

The integrated 13-suite run passed 171 tests. Two additional converter receipt-negative cases then passed within the 28-case converter suite. Owned ESLint passed; typecheck passed. Tests cover actual SQLite files, safe snapshot backup, same-schema reopens, corruption rejection, M02 rollback and synthetic physical conversion with real WAL/Lance data.

A separate run between those passes recorded one intermittent `legacy-isolated` recovery returning blocked (170 passed / 1 failed). The original assertion omitted the fixed code; its failure is retained privately. The assertion now displays the fixed error code without weakening its expectation. The isolated converter suite and the same 13-suite concurrent run passed afterward. The cause is not established and is not declared repaired.

For S06A, the existing pre-M02 roster commit accepts a main-owned synchronous source guard inside its immediate write transaction after the durable replay branch. A focused test verifies rejected guards leave facts/operations untouched and durable replay does not rerun the guard. The M02 name-only-write rejection remains in place. This is a temporary consumer boundary, not completion of S09.

No full application suite, cloud CI, real author project conversion, hardware power-loss test or model call was performed for this central delta. Independent review remains required.
