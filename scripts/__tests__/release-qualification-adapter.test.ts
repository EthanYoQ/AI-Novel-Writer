import { describe, expect, it } from 'vitest'
import { normalizeLegacyReceipt } from '../../.release/scripts/legacy-qualification-adapter.mjs'
import { assertAcceptanceReceipt, assertSigningReceipt } from '../../.release/scripts/github-desktop-promotion.mjs'

const macSigning = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  accepted: true,
  observations: ['codesign observed an ad-hoc signature without a Developer ID identity'],
  platform: 'darwin',
  arch: 'arm64',
  status: 'ad_hoc_or_unsigned',
  validationResult: 'Observed ad-hoc signing; no Developer ID identity.',
  unsignedDistributionImpact: 'Gatekeeper may require manual confirmation.',
  direct: {
    codeSigning: { observed: 'ad_hoc', hasDeveloperIdIdentity: false },
    notarization: { observed: 'not_notarized' },
  },
  ...overrides,
})

describe('legacy qualification receipt adapter', () => {
  it('maps only the known macOS vocabulary while retaining raw provenance', () => {
    const normalized = normalizeLegacyReceipt({
      platform: 'macos',
      relativePath: 'acceptance/signing.json',
      rawBytes: Buffer.from(JSON.stringify(macSigning())),
    })

    const entityReceipt = { ...normalized, platform: 'macos-arm64' }
    expect(entityReceipt).toMatchObject({
      platform: 'macos-arm64',
      status: 'unsigned',
      validationResult: 'Observed ad-hoc signing; no Developer ID identity.',
      observations: ['codesign observed an ad-hoc signature without a Developer ID identity'],
      direct: {
        codeSigning: { observed: 'ad_hoc', hasDeveloperIdIdentity: false },
        notarization: { observed: 'not_notarized' },
      },
    })
    expect(normalized.sourceReceiptRawBytesSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(normalized.sourceClassification).toEqual({ platform: 'darwin', signingStatus: 'ad_hoc_or_unsigned' })
    expect(() => assertAcceptanceReceipt(entityReceipt, 'macos-arm64', 'acceptance/signing.json')).not.toThrow()
    expect(() => assertSigningReceipt(entityReceipt, {
      status: 'unsigned',
      validationResult: entityReceipt.validationResult,
      unsignedDistributionImpact: entityReceipt.unsignedDistributionImpact,
    })).not.toThrow()
  })

  it('maps a verified unsigned macOS observation without a Developer ID identity', () => {
    const normalized = normalizeLegacyReceipt({
      platform: 'macos',
      relativePath: 'acceptance/signing.json',
      rawBytes: Buffer.from(JSON.stringify(macSigning({
        observations: ['codesign verified that the bundle is not signed'],
        validationResult: 'Verified unsigned bundle; no Developer ID identity.',
        direct: {
          codeSigning: { observed: 'unsigned', hasDeveloperIdIdentity: false },
          notarization: { observed: 'not_notarized' },
        },
      }))),
    })

    expect(normalized).toMatchObject({
      platform: 'macos',
      status: 'unsigned',
      direct: {
        codeSigning: { observed: 'unsigned', hasDeveloperIdIdentity: false },
      },
      sourceClassification: { platform: 'darwin', signingStatus: 'ad_hoc_or_unsigned' },
    })
  })

  it.each([
    ['Developer ID identity', macSigning({ direct: { codeSigning: { observed: 'developer_id', hasDeveloperIdIdentity: true } } })],
    ['unsigned observation with a Developer ID identity', macSigning({ direct: { codeSigning: { observed: 'unsigned', hasDeveloperIdIdentity: true } } })],
    ['unknown signing observation', macSigning({ direct: { codeSigning: { observed: 'unrecognized_signature', hasDeveloperIdIdentity: false } } })],
    ['signed status', macSigning({ status: 'signed' })],
    ['unknown status', macSigning({ status: 'mystery' })],
  ])('fails closed for %s instead of inferring unsigned', (_case, receipt) => {
    expect(() => normalizeLegacyReceipt({
      platform: 'macos',
      relativePath: 'acceptance/signing.json',
      rawBytes: Buffer.from(JSON.stringify(receipt)),
    })).toThrow()
  })
})
