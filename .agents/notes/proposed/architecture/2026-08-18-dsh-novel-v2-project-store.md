# DSH AI Novel V2 project store

## Decision

The DSH plugin treats `.ai-novel/novel.db` as a project-owned content artifact, not as DSH host storage. A plugin-owned `NovelStore` opens the database with Node's built-in SQLite driver, stamps application and schema identity, enforces foreign keys, serializes writes through one exclusive host connection, and records project/workspace binding in database metadata.

Authoritative writes come only from the sidebar's closed typed command RPC. Model tools are read-only plus a persistent non-authoritative proposal inbox. A proposal bundle may contain multiple single-aggregate ChangeSets, but the sidebar applies them sequentially and surfaces partial failure instead of promising a cross-asset transaction.

## Rationale

DSH storage domain intentionally provides typed KV records without per-workspace scope or cross-table transactions. That is appropriate for harness-owned registries, but not for chapter artifact history, review/revision parentage, task recovery, and workspace-bound project identity. Treating the database as project content keeps the data portable with the workspace while keeping the DSH storage seam unchanged.

The plugin does not append a custom DSH session event for sidebar commits. Out-of-repo event types are not in DSH's known persistent event vocabulary and the public session append API cannot mark an event ignorable. The project database `changes` table is therefore the authoritative commit audit. A later `novel_read` tool result reconstructs the model-visible state from the durable session log.

## Impact

V1 projects require an explicit migration with a source fingerprint, archived source files, a fully closed staging database, and idempotent crash recovery. The project directory must ignore the database and its lock/journal sidecars. Local backup is the user's responsibility until an export flow exists. Real Cloud/synchronized folders are unsupported because they can violate SQLite locking and atomic publication semantics.
