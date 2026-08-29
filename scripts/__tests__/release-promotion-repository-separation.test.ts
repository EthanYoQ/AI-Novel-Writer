import { describe, expect, it } from 'vitest'

import {
  assertPromotionPlanIdentity,
  assertQualificationEvidenceRepositories,
  resolvePromotionRepositories,
} from '../../.release/scripts/github-desktop-promotion.mjs'

const expectedSha = '1'.repeat(40)

describe('desktop promotion repository separation', () => {
  it('defaults qualification to the release repository and accepts an explicit qualification repository', () => {
    expect(resolvePromotionRepositories({ repository: 'release-owner/app' })).toEqual({
      qualificationRepository: 'release-owner/app',
      releaseRepository: 'release-owner/app',
    })
    expect(resolvePromotionRepositories({
      repository: 'release-owner/app',
      'qualification-repository': 'builder-owner/app-builds',
    })).toEqual({
      qualificationRepository: 'builder-owner/app-builds',
      releaseRepository: 'release-owner/app',
    })
  })

  it('requires both qualification evidence files to name the qualification repository', () => {
    expect(() => assertQualificationEvidenceRepositories({
      contract: { repository: 'builder-owner/app-builds' },
      ledger: { repository: 'builder-owner/app-builds' },
      qualificationRepository: 'builder-owner/app-builds',
    })).not.toThrow()
    expect(() => assertQualificationEvidenceRepositories({
      contract: { repository: 'release-owner/app' },
      ledger: { repository: 'builder-owner/app-builds' },
      qualificationRepository: 'builder-owner/app-builds',
    })).toThrow('release contract repository does not match the qualification repository')
    expect(() => assertQualificationEvidenceRepositories({
      contract: { repository: 'builder-owner/app-builds' },
      ledger: { repository: 'release-owner/app' },
      qualificationRepository: 'builder-owner/app-builds',
    })).toThrow('run ledger repository does not match the qualification repository')
  })

  it('fails closed unless publish receives a plan bound to both exact repositories', () => {
    const identity = {
      qualificationRepository: 'builder-owner/app-builds',
      releaseRepository: 'release-owner/app',
      expectedSha,
      tag: 'v1.2.3',
      version: '1.2.3',
    }
    expect(() => assertPromotionPlanIdentity(identity, identity)).not.toThrow()
    expect(() => assertPromotionPlanIdentity({
      ...identity,
      qualificationRepository: 'attacker/builds',
    }, identity)).toThrow('verified promotion plan identity mismatch')
    expect(() => assertPromotionPlanIdentity({
      ...identity,
      releaseRepository: 'attacker/releases',
    }, identity)).toThrow('verified promotion plan identity mismatch')
  })
})
