import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, initProjectDatabase } from '../../database'
import { ConsistencyExemptionRepository } from '../consistency-exemption-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-consistency-exemption-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('ConsistencyExemptionRepository', () => {
  it('persists only the stable fact key, reason, and revocation state', () => {
    ConsistencyExemptionRepository.save('open-thread:1:key', '刻意延后到第三章')
    expect(ConsistencyExemptionRepository.list()).toEqual([{
      stableFactKey: 'open-thread:1:key',
      reason: '刻意延后到第三章',
      revoked: false,
    }])

    ConsistencyExemptionRepository.revoke('open-thread:1:key')
    expect(ConsistencyExemptionRepository.list()[0]).toEqual({
      stableFactKey: 'open-thread:1:key',
      reason: '刻意延后到第三章',
      revoked: true,
    })
  })

  it('rejects an empty reason and can reactivate an existing stable key', () => {
    expect(() => ConsistencyExemptionRepository.save('open-thread:1:key', '  ')).toThrow()
    ConsistencyExemptionRepository.save('open-thread:1:key', '第一次原因')
    ConsistencyExemptionRepository.revoke('open-thread:1:key')
    ConsistencyExemptionRepository.save('open-thread:1:key', '新的原因')
    expect(ConsistencyExemptionRepository.list()).toEqual([{
      stableFactKey: 'open-thread:1:key', reason: '新的原因', revoked: false,
    }])
  })
})
