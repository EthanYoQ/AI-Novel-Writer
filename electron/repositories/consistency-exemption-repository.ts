import { getProjectDb } from '../database'
import type { ConsistencyExemption } from '../../src/shared/consistency-preflight'

function requireText(value: string, code: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 500) throw new Error(code)
  return normalized
}

export class ConsistencyExemptionRepository {
  static list(db = getProjectDb()): ConsistencyExemption[] {
    if (!db) return []
    const rows = db.prepare(`
      SELECT stable_fact_key AS stableFactKey, reason, revoked
      FROM consistency_exemptions ORDER BY stable_fact_key
    `).all() as Array<{ stableFactKey: string; reason: string; revoked: number }>
    return rows.map(row => ({ ...row, revoked: row.revoked === 1 }))
  }

  static save(stableFactKey: string, reason: string): void {
    const db = getProjectDb()
    if (!db) throw new Error('PROJECT_NOT_OPEN')
    db.prepare(`
      INSERT INTO consistency_exemptions (stable_fact_key, reason, revoked)
      VALUES (?, ?, 0)
      ON CONFLICT(stable_fact_key) DO UPDATE SET reason = excluded.reason, revoked = 0
    `).run(requireText(stableFactKey, 'CONSISTENCY_EXEMPTION_KEY_INVALID'), requireText(reason, 'CONSISTENCY_EXEMPTION_REASON_INVALID'))
  }

  static revoke(stableFactKey: string): void {
    const db = getProjectDb()
    if (!db) throw new Error('PROJECT_NOT_OPEN')
    db.prepare('UPDATE consistency_exemptions SET revoked = 1 WHERE stable_fact_key = ?')
      .run(requireText(stableFactKey, 'CONSISTENCY_EXEMPTION_KEY_INVALID'))
  }
}
