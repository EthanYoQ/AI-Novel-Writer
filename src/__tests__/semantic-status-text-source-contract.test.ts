import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const srcRoot = resolve(process.cwd(), 'src')

function productionStyleSources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (name === '__tests__') return []
    if (statSync(path).isDirectory()) return productionStyleSources(path)
    return /\.(?:tsx|css)$/.test(name) ? [path] : []
  })
}

describe('semantic status text source contract', () => {
  it('does not encode information or category text with fixed Tailwind palette classes', () => {
    const violations = productionStyleSources(srcRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return [...source.matchAll(/text-(?:red|green|yellow|amber|orange|blue|purple|violet|indigo|emerald|teal|cyan|sky|lime|rose|pink|fuchsia)-\d+(?:\/\d+)?/g)]
        .map((match) => `${relative(process.cwd(), path)}:${match[0]}`)
    })

    expect(violations).toEqual([])
  })

  it('keeps shared draft status labels on semantic theme text tokens', () => {
    const source = readFileSync(resolve(srcRoot, 'shared/draft-status.ts'), 'utf8')
    const colorMap = source.match(/export const DRAFT_STATUS_COLOR[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(colorMap).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/)
    expect(colorMap).not.toMatch(/\brgb(?:a)?\(/)
  })

  it('limits decoration-only status colors to an explicit reviewed allowlist', () => {
    const allowed = new Set([
      'src/index.css:.ai-task-capsule--complete',
      'src/styles/agent-tools.css:.tool-call-status.completed',
      'src/styles/agent-tools.css:.tool-call-status.failed',
      'src/styles/agent-tools.css:.tool-call-status.waiting_confirm',
      'src/styles/agent-tools.css:.confirm-card-btn.approve',
    ])
    const violations = productionStyleSources(srcRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      if (path.endsWith('index.css') || path.endsWith('agent-tools.css')) {
        return [...source.matchAll(/([^{}]+)\{[^{}]*color:\s*var\(--color-(?:success|error|warning)\);[^{}]*\}/g)]
          .map((match) => `${relative(process.cwd(), path).replace(/\\/g, '/')}:${match[1].trim()}`)
          .filter((entry) => !allowed.has(entry))
      }
      return []
    })

    expect(violations).toEqual([])
  })
})
