import type { MigrationImplementation, SchemaReader, SchemaWriter } from './registry';
/** M01 is installed only by the desktop registry; repositories never execute DDL. */
export const M01_GENERATION_SQL = `
CREATE TABLE generation_roots (
 root_action_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
 action_json TEXT NOT NULL, budget_json TEXT NOT NULL,
 active_elapsed_ms INTEGER NOT NULL DEFAULT 0, active_since_ms INTEGER,
 blocked_code TEXT, revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE generation_runs (
 run_id TEXT PRIMARY KEY, root_action_id TEXT NOT NULL REFERENCES generation_roots(root_action_id),
 binding_json TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, open_key TEXT NOT NULL UNIQUE
);
CREATE TABLE generation_attempts (
 attempt_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL REFERENCES generation_runs(run_id), root_action_id TEXT NOT NULL REFERENCES generation_roots(root_action_id),
 attempt_json TEXT NOT NULL, usage_receipt_json TEXT, invocation_nonce TEXT NOT NULL,
 UNIQUE(run_id, invocation_nonce)
);
CREATE TABLE generation_artifacts (
 artifact_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES generation_attempts(attempt_id),
 run_id TEXT NOT NULL REFERENCES generation_runs(run_id), artifact_json TEXT NOT NULL,
 revision INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'partial'
);`;
export function createM01Migration(verifyKnownSchema: (db: SchemaReader) => boolean): MigrationImplementation {
    return Object.freeze({ id: 'M01', from: 1, to: 2, owner: 'S05',
        migrate: (db: SchemaWriter) => db.executeMigrationSql(M01_GENERATION_SQL), verify: verifyKnownSchema });
}
