import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const checker = resolve(process.cwd(), 'scripts/check-i18n-coverage.mjs')

function writeFixture(root: string, relativePath: string, content: string) {
  const target = join(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function runChecker(root: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, output }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return {
      status: failed.status ?? 1,
      output: `${failed.stdout ?? ''}${failed.stderr ?? ''}`,
    }
  }
}

describe('i18n coverage boundary scanner', () => {
  it('rejects a Prompt variable description rendered without localization', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-prompt-variable-'))
    try {
      writeFixture(root, 'src/components/settings/PromptSettings.tsx', `
        export function PromptVariable({ desc }: { desc: string }) {
          return <button title={desc}><span>{desc}</span></button>
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain('src/components/settings/PromptSettings.tsx')
      expect(result.output).toContain('[prompt-variable-description]')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects raw renderer alerts and raw main-process return errors in real UI routes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-boundary-'))
    try {
      writeFixture(root, 'src/stores/project-store.ts', `
        import { alertError } from '../components/ui/AlertDialog'
        alertError('无法打开项目', { title: 'Open project failed' })
      `)
      writeFixture(root, 'src/components/panels/agent/artifact-open.ts', `
        import { alertError } from '../../ui/AlertDialog'
        alertError('Cannot open artifact', { title: '无法打开产物' })
      `)
      writeFixture(root, 'electron/controllers/fs-controller.ts', `
        function failed(error: unknown) {
          const message = String(error)
          return { success: false, content: '', error: message }
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain('src/stores/project-store.ts')
      expect(result.output).toContain('src/components/panels/agent/artifact-open.ts')
      expect(result.output).toContain('electron/controllers/fs-controller.ts')
      expect(result.output).toContain('[notification:alertError]')
      expect(result.output).toContain('[main-return:error]')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('permits localized boundary copy while ignoring prompts, parsers, and internal logs', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-policy-'))
    try {
      writeFixture(root, 'src/stores/project-store.ts', `
        import { alertError } from '../components/ui/AlertDialog'
        const text = (zh: string, en: string) => zh || en
        const prompt = 'You are a creative novel-writing assistant.'
        console.error('internal project diagnostic', prompt)
        alertError(text('无法打开项目', 'Could not open project.'), {
          title: text('打开项目失败', 'Open project failed'),
        })
      `)
      writeFixture(root, 'src/components/panels/agent/artifact-open.ts', `
        import { alertError } from '../../ui/AlertDialog'
        const text = (zh: string, en: string) => zh || en
        alertError(text('无法打开产物', 'Could not open artifact.'), {
          title: text('无法打开产物', 'Could not open artifact'),
        })
      `)
      writeFixture(root, 'electron/controllers/fs-controller.ts', `
        const text = (zh: string, en: string) => zh || en
        function failed() {
          return { success: false, content: '', error: text('文件读取失败', 'Could not read the file.') }
        }
      `)
      writeFixture(root, 'src/services/parsers/response-parser.ts', `
        export function parseModelResponse(raw: string) {
          if (!raw) throw new Error('parser input is empty')
          return raw
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(0)
      expect(result.output).toContain('i18n coverage check passed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
