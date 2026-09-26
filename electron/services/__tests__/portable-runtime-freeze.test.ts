import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PortableRuntimeFreezeError, readPortableRuntimeFreeze } from '../portable-runtime-freeze'

const roots: string[] = []
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-runtime-freeze-'))
  fs.mkdirSync(path.join(root, '.ai-novel'))
  roots.push(root)
  return root
}
function writeFreeze(root: string, records: unknown[] = []): void {
  fs.writeFileSync(path.join(root, '.ai-novel', 'portable-runtime-freeze.json'), JSON.stringify({
    version: 1, originProjectId: '11111111-1111-4111-8111-111111111111', snapshotGeneration: 'snapshot-1',
    nonReplayable: true, requiresRuntimeFreezeGuard: true, records, avatarReferenceProjections: [],
  }), { mode: 0o600 })
}
function frozen(table: string, recordId: string) {
  return { projectionId: `history:${table}:${recordId}`, table, recordId, terminalState: 'pending', projection: {},
    projectionHash: 'a'.repeat(64), excludedFields: [], nonReplayable: true, originalReceiptVerified: false }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('portable runtime freeze sidecar', () => {
  it('leaves ordinary projects and new IDs mutable while freezing only declared history', () => {
    const root = fixture()
    expect(readPortableRuntimeFreeze(root).active).toBe(false)
    writeFreeze(root, [frozen('import_runs', 'old-run')])
    const guard = readPortableRuntimeFreeze(root)
    expect(guard.active).toBe(true)
    expect(guard.isFrozen('import_runs', 'old-run')).toBe(true)
    expect(guard.isFrozen('import_runs', 'new-run')).toBe(false)
    expect(() => guard.assertMutable('import_runs', 'old-run')).toThrow('PORTABLE_RUNTIME_FROZEN')
    expect(() => guard.assertMutable('import_runs', 'new-run')).not.toThrow()
  })

  it('fails closed when a transfer authority lacks a valid sidecar', () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, '.ai-novel', 'portable-transfer-authority.json'), '{}', { mode: 0o600 })
    expect(() => readPortableRuntimeFreeze(root)).toThrow(PortableRuntimeFreezeError)
    writeFreeze(root, [frozen('import_runs', 'duplicate'), frozen('import_runs', 'duplicate')])
    expect(() => readPortableRuntimeFreeze(root)).toThrow('PORTABLE_RUNTIME_FREEZE_INVALID')
  })

  it('rejects a sidecar path replacement after its descriptor has opened', () => {
    const root = fixture()
    writeFreeze(root, [frozen('import_runs', 'old-run')])
    const file = path.join(root, '.ai-novel', 'portable-runtime-freeze.json')
    expect(() => readPortableRuntimeFreeze(root, { afterOpen: opened => {
      if (opened !== file) return
      fs.renameSync(file, `${file}.old`)
      writeFreeze(root, [frozen('import_runs', 'replacement')])
    } })).toThrow('PORTABLE_RUNTIME_FREEZE_INVALID')
  })
})
