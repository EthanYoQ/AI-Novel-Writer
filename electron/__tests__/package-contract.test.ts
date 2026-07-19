import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  packageManager?: string
  optionalDependencies?: Record<string, string>
}

describe('release dependency contract', () => {
  it('uses one pinned package manager and exposes the Windows LanceDB binding', () => {
    expect(pkg.packageManager).toBe('pnpm@11.11.0')
    expect(pkg.optionalDependencies?.['@lancedb/lancedb-win32-x64-msvc']).toBe('0.27.2')
    expect(existsSync('package-lock.json')).toBe(false)
  })
})
