import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const packageJsonPath = path.join(repositoryRoot, 'package.json')
const browserConfigPath = path.join(repositoryRoot, 'vitest.browser.config.ts')
const browserTestPath = path.join(
  repositoryRoot,
  'src',
  'components',
  'panels',
  'sidebar',
  '__tests__',
  'sidebar-legacy-character-render.browser.tsx',
)

function readRequired(relativePath: string) {
  const file = path.join(repositoryRoot, relativePath)
  expect(existsSync(file), `Missing browser qualification contract file: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

describe('renderer browser qualification contract', () => {
  it('keeps real-browser tests out of the default node runner behind a dedicated command', () => {
    const packageMetadata = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>
    }
    const browserConfig = readFileSync(browserConfigPath, 'utf8')

    expect(existsSync(browserTestPath)).toBe(true)
    expect(packageMetadata.scripts?.test).toBe('vitest run')
    expect(packageMetadata.scripts?.['test:browser']).toBe(
      'vitest run --config vitest.browser.config.ts',
    )
    expect(browserConfig).toContain("include: ['src/**/*.browser.tsx']")
    expect(browserConfig).not.toContain('.browser.test.tsx')
    expect(browserConfig).toContain("api: { host: '127.0.0.1' }")
    expect(browserConfig).not.toMatch(/api:\s*\{[^}]*\bport\s*:/s)
    expect(browserConfig).toContain('provider: playwright(')
    expect(browserConfig).toContain('headless: true')
  })

  it.each([
    '.github/workflows/windows-cloud-build-test.yml',
    '.github/workflows/macos-arm64-cloud-build.yml',
  ])('installs Chromium and runs browser qualification in %s', (workflowPath) => {
    const workflow = readRequired(workflowPath)

    expect(workflow).toContain('pnpm exec playwright install chromium')
    expect(workflow).toContain('pnpm run test:browser')
    expect(workflow.indexOf('pnpm exec playwright install chromium'))
      .toBeLessThan(workflow.indexOf('pnpm run test:browser'))
  })
})
