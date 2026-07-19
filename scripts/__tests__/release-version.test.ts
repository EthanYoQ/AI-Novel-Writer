import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('v0.2.0 release metadata', () => {
  it('uses the release version in package metadata', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.2.0')
  })

  it('keeps stale Mythpen branding out of release metadata', () => {
    const releaseConfig = readFileSync('package.json', 'utf8')
    expect(releaseConfig.toLowerCase()).not.toContain('mythpen')
  })
})
