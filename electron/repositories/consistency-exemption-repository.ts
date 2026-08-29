import { getProjectDb } from '../database'
import type { ConsistencyExemption } from '../../src/shared/consistency-preflight'

function requireText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 500) throw new Error(`${label}无效`)
  return normalized
}

export class ConsistencyExemptionRepository {
  static list(): ConsistencyExemption[] {
    const db = getProjectDb()
    if (!db) return []
    const rows = db.prepare(`
      SELECT stable_fact_key AS stableFactKey, reason, revoked
      FROM consistency_exemptions ORDER BY stable_fact_key
    `).all() as Array<{ stableFactKey: string; reason: string; revoked: number }>
    return rows.map(row => ({ ...row, revoked: row.revoked === 1 }))
  }

  static save(stableFactKey: string, reason: string): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    db.prepare(`
      INSERT INTO consistency_exemptions (stable_fact_key, reason, revoked)
      VALUES (?, ?, 0)
      ON CONFLICT(stable_fact_key) DO UPDATE SET reason = excluded.reason, revoked = 0
    `).run(requireText(stableFactKey, '稳定事实键'), requireText(reason, '豁免原因'))
  }

  static revoke(stableFactKey: string): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    db.prepare('UPDATE consistency_exemptions SET revoked = 1 WHERE stable_fact_key = ?')
      .run(requireText(stableFactKey, '稳定事实键'))
  }
}
