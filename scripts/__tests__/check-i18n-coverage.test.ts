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

  it('ignores Han text under renderer __tests__ while checking sibling production files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-renderer-tests-'))
    try {
      writeFixture(root, 'src/components/layout/v2/__tests__/layout.browser.tsx', `
        export function LayoutFixture() {
          return <button>测试夹具</button>
        }
      `)
      writeFixture(root, 'src/components/layout/v2/Feature.tsx', `
        export function Feature() {
          return <button>生产文案</button>
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain('src/components/layout/v2/Feature.tsx')
      expect(result.output).toContain('生产文案')
      expect(result.output).not.toContain('src/components/layout/v2/__tests__/layout.browser.tsx')
      expect(result.output).not.toContain('测试夹具')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects English copy that writes a count with a fixed plural noun, and accepts the plural helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-plural-'))
    try {
      writeFixture(root, 'src/components/stage/Counts.tsx', `
        const text = (zh: string, en: string) => zh || en
        const pluralEn = (count: number, noun: string) => count === 1 ? noun : noun + 's'
        export function Counts({ total, lines }: { total: number; lines: number }) {
          return <p title={text(\`共 \${total} 章\`, \`The book has \${total} chapters.\`)}>
            {text(\`\${lines} 行\`, \`\${lines} \${pluralEn(lines, 'line')}\`)}
            {text(\`\${lines} 个文件\`, lines > 1 ? \`\${lines} files selected\` : 'One file')}
          </p>
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain('Found 2 unlocalized visible strings')
      expect(result.output).toContain('src/components/stage/Counts.tsx:5 [english-plural] `The book has ${total} chapters.`')
      expect(result.output).toContain('src/components/stage/Counts.tsx:7 [english-plural] `${lines} files selected`')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('scans the English argument of three-argument translators, counts followed by modifiers, and points irregular plurals at the explicit form', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-plural-gaps-'))
    try {
      writeFixture(root, 'src/components/stage/Gaps.tsx', `
        const text = (zh: string, en: string) => zh || en
        const localize = (locale: string, zh: string, en: string) => locale === 'zh-CN' ? zh : en
        const stepDesc = (key: string, zh: string, en: string) => key ? zh : en
        export function Gaps({ n, locale }: { n: number; locale: string }) {
          return <p title={localize(locale, \`\${n} 章\`, \`\${n} chapters\`)}>
            {stepDesc('synopsis', \`\${n} 章大纲\`, \`Outline for \${n} chapters\`)}
            {text(\`现有 \${n} 章蓝图\`, \`Replace the \${n} existing blueprints\`)}
            {text(\`\${n} 条事件\`, \`its \${n} confirmed events\`)}
            {text(\`\${n} 段\`, \`\${n} text chunks\`)}
            {text(\`\${n} 条\`, \`\${n} entries\`)}
          </p>
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain('Found 6 unlocalized visible strings')
      expect(result.output).toContain('src/components/stage/Gaps.tsx:6 [english-plural] `${n} chapters`')
      expect(result.output).toContain('src/components/stage/Gaps.tsx:7 [english-plural] `Outline for ${n} chapters`')
      expect(result.output).toContain('src/components/stage/Gaps.tsx:8 [english-plural] `Replace the ${n} existing blueprints`')
      expect(result.output).toContain('src/components/stage/Gaps.tsx:9 [english-plural] `its ${n} confirmed events`')
      expect(result.output).toContain('src/components/stage/Gaps.tsx:10 [english-plural] `${n} text chunks`')
      expect(result.output).toContain("Write the noun with pluralEn(count, 'chapter'); pass irregular plurals explicitly, as in pluralEn(count, 'entry', 'entries').")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects these or those before a count and have or are right after it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-plural-agreement-'))
    try {
      writeFixture(root, 'src/components/stage/Agreement.tsx', `
        const text = (zh: string, en: string) => zh || en
        const pluralEn = (count: number, noun: string) => count === 1 ? noun : noun + 's'
        export function Agreement({ n }: { n: number }) {
          return <p title={text(\`这 \${n} 行\`, \`Clearing removes these \${n} log \${pluralEn(n, 'line')}.\`)}>
            {text(\`\${n} 个有修改\`, \`\${n} have unsaved changes\`)}
            {text(\`\${n} 个文件\`, \`Close \${n} \${pluralEn(n, 'file')}.\`)}
            {text(\`连同 \${n} 条事件\`, \`The thread and its \${n} confirmed \${pluralEn(n, 'event')} are removed.\`)}
          </p>
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain('Found 2 unlocalized visible strings')
      expect(result.output).toContain("src/components/stage/Agreement.tsx:5 [english-plural] `Clearing removes these ${n} log ${pluralEn(n, 'line')}.`")
      expect(result.output).toContain('src/components/stage/Agreement.tsx:6 [english-plural] `${n} have unsaved changes`')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('checks have or are after a pluralEn subject, the English fallback of projectError and artifactError, and candidates; points verbs at pluralEn too', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-plural-subjects-'))
    try {
      writeFixture(root, 'src/components/stage/Subjects.tsx', `
        const text = (zh: string, en: string) => zh || en
        const pluralEn = (count: number, noun: string) => count === 1 ? noun : noun + 's'
        const projectError = (error: unknown, zh = '出错了。', en = 'Something went wrong.') => error ? String(error) : zh || en
        const artifactError = (error: unknown, zh = '读取失败。', en = 'Could not read.') => error ? String(error) : zh || en
        export function Subjects({ n }: { n: number }) {
          return <p title={text(\`\${n} 个文件有修改\`, \`\${n} \${pluralEn(n, 'file')} have unsaved changes\`)}>
            {text(\`连同 \${n} 条事件\`, \`The thread and its \${n} confirmed \${pluralEn(n, 'event')} are removed.\`)}
            {projectError(null, \`\${n} 章没有保存\`, \`\${n} chapters were not saved\`)}
            {artifactError(null, \`\${n} 个文件读不出\`, \`Could not read \${n} files\`)}
            {text(\`\${n} 个角色候选\`, \`\${n} character candidates\`)}
          </p>
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain('Found 4 unlocalized visible strings')
      expect(result.output).toContain("src/components/stage/Subjects.tsx:7 [english-plural] `${n} ${pluralEn(n, 'file')} have unsaved changes`")
      expect(result.output).toContain('src/components/stage/Subjects.tsx:9 [english-plural] `${n} chapters were not saved`')
      expect(result.output).toContain('src/components/stage/Subjects.tsx:10 [english-plural] `Could not read ${n} files`')
      expect(result.output).toContain('src/components/stage/Subjects.tsx:11 [english-plural] `${n} character candidates`')
      expect(result.output).toContain("Write the noun with pluralEn(count, 'chapter'); pass irregular plurals explicitly, as in pluralEn(count, 'entry', 'entries').")
      expect(result.output).toContain("Write a verb that follows the count the same way, as in pluralEn(count, 'has', 'have').")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads checks and changes after an interpolation as counted nouns, verb uses included', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-plural-verbs-'))
    try {
      writeFixture(root, 'src/components/stage/Verbs.tsx', `
        const text = (zh: string, en: string) => zh || en
        export function Verbs({ n, passed, revised, name, who }: { n: number; passed: number; revised: number; name: string; who: string }) {
          return <p>
            {text(\`\${who} 检查本章\`, \`\${who} checks the chapter\`)}
            {text(\`\${name} 改大纲\`, \`\${name} changes the outline\`)}
            {text(\`\${name} 改过\`, \`\${name} made changes\`)}
            {text(\`\${n} 处变更\`, \`\${n} changes: \${revised} from the revision\`)}
            {text(\`通过 \${passed} 项\`, \`\${passed} checks passed\`)}
            {text(\`\${n} 处未保存\`, \`\${n} unsaved changes\`)}
            {text(\`\${n} 处将丢失\`, \`\${n} changes that will be lost\`)}
            {text(\`\${passed} 项失败\`, \`\${passed} checks that failed\`)}
          </p>
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain('Found 8 unlocalized visible strings')
      expect(result.output).toContain('src/components/stage/Verbs.tsx:5 [english-plural] `${who} checks the chapter`')
      expect(result.output).toContain('src/components/stage/Verbs.tsx:6 [english-plural] `${name} changes the outline`')
      expect(result.output).toContain('src/components/stage/Verbs.tsx:7 [english-plural] `${name} made changes`')
      expect(result.output).toContain('src/components/stage/Verbs.tsx:8 [english-plural] `${n} changes: ${revised} from the revision`')
      expect(result.output).toContain('src/components/stage/Verbs.tsx:9 [english-plural] `${passed} checks passed`')
      expect(result.output).toContain('src/components/stage/Verbs.tsx:10 [english-plural] `${n} unsaved changes`')
      expect(result.output).toContain('src/components/stage/Verbs.tsx:11 [english-plural] `${n} changes that will be lost`')
      expect(result.output).toContain('src/components/stage/Verbs.tsx:12 [english-plural] `${passed} checks that failed`')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exempts a compound subject only within the clause before the count', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-plural-clause-'))
    try {
      writeFixture(root, 'src/components/stage/Clause.tsx', `
        const text = (zh: string, en: string) => zh || en
        const pluralEn = (count: number, noun: string) => count === 1 ? noun : noun + 's'
        export function Clause({ n }: { n: number }) {
          return <p>
            {text(\`保存并继续：\${n} 个文件未保存\`, \`Save and continue: \${n} \${pluralEn(n, 'file')} have unsaved changes\`)}
            {text(\`连同 \${n} 条事件\`, \`The thread and its \${n} confirmed \${pluralEn(n, 'event')} are removed.\`)}
            {text(\`保存并继续 · \${n} 个文件未保存\`, \`Save and continue · \${n} \${pluralEn(n, 'file')} have unsaved changes\`)}
            {text(\`保存并继续，\${n} 个文件未保存\`, \`Save and continue — \${n} \${pluralEn(n, 'file')} have unsaved changes\`)}
            {text(\`保存并继续\\n\${n} 个文件未保存\`, \`Save and continue\\n\${n} \${pluralEn(n, 'file')} have unsaved changes\`)}
            {text(\`保存并继续。\${n} 个文件未保存\`, \`Save and continue。\${n} \${pluralEn(n, 'file')} have unsaved changes\`)}
          </p>
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain('Found 5 unlocalized visible strings')
      expect(result.output).toContain("src/components/stage/Clause.tsx:6 [english-plural] `Save and continue: ${n} ${pluralEn(n, 'file')} have unsaved changes`")
      expect(result.output).toContain("src/components/stage/Clause.tsx:8 [english-plural] `Save and continue · ${n} ${pluralEn(n, 'file')} have unsaved changes`")
      expect(result.output).toContain("src/components/stage/Clause.tsx:9 [english-plural] `Save and continue — ${n} ${pluralEn(n, 'file')} have unsaved changes`")
      expect(result.output).toContain("src/components/stage/Clause.tsx:10 [english-plural] `Save and continue\\n${n} ${pluralEn(n, 'file')} have unsaved changes`")
      expect(result.output).toContain("src/components/stage/Clause.tsx:11 [english-plural] `Save and continue。${n} ${pluralEn(n, 'file')} have unsaved changes`")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a plural noun after the end of a number range, which is never one', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-plural-range-'))
    try {
      writeFixture(root, 'src/components/stage/Range.tsx', `
        const text = (zh: string, en: string) => zh || en
        export function Range({ limit, total }: { limit: number; total: number }) {
          return <p>{text(\`请选择 1–\${limit} 章\`, \`Select 1-\${limit} consecutive chapters within chapters 1–\${total}.\`)}</p>
        }
      `)

      expect(runChecker(root)).toEqual({ status: 0, output: 'i18n coverage check passed: no unlocalized renderer or main-boundary copy\n' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('checks {name} placeholders filled from the params argument like template interpolations', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-plural-placeholder-'))
    try {
      writeFixture(root, 'src/components/stage/Placeholders.tsx', `
        const text = (zh: string, en: string, params?: Record<string, unknown>) => zh || en || params
        const localize = (locale: string, zh: string, en: string, params?: Record<string, unknown>) => locale || zh || en || params
        const pluralEn = (count: number, noun: string) => count === 1 ? noun : noun + 's'
        export function Merge({ done, total, name }: { done: number; total: number; name: string }) {
          return <p>
            {text('已采用 {done}/{total} 处变更', '{done}/{total} changes applied', { done, total })}
            {text('已采用 {done}/{total} 处变更', \`{done}/{total} \${pluralEn(total, 'change')} applied\`, { done, total })}
            {text('共 {count} 处变更', '{count} {noun} applied', { count: total, noun: pluralEn(total, 'change') })}
            {text('{count} 个文件未保存', '{count} {noun} have unsaved changes', { count: total, noun: pluralEn(total, 'file') })}
            {localize('en-US', '已关闭 {count} 个文件', 'Closed {count} files', { count: total })}
            {text('{name} 已保存', '{name} is saved', { name })}
            {text('示例', 'Write {count} chapters literally')}
          </p>
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain('Found 3 unlocalized visible strings')
      expect(result.output).toContain("src/components/stage/Placeholders.tsx:7 [english-plural] '{done}/{total} changes applied'")
      expect(result.output).toContain("src/components/stage/Placeholders.tsx:10 [english-plural] '{count} {noun} have unsaved changes'")
      expect(result.output).toContain("src/components/stage/Placeholders.tsx:11 [english-plural] 'Closed {count} files'")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('checks visible copy in review-checklist.ts like the review report it was moved out of', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-review-checklist-'))
    try {
      writeFixture(root, 'src/components/editor/review-checklist.ts', `
        const text = (zh: string, en: string) => zh || en
        export const dimensions = [
          { id: 'plot', label: '情节推进' },
          { id: 'voice', label: text('人物声音', 'Character voice') },
        ]
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      expect(result.output).toContain("src/components/editor/review-checklist.ts:4 [workflow:label] '情节推进'")
      expect(result.output).not.toContain('人物声音')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects workflow command errors that reach the failure panel unlocalized, as raw codes, or as forwarded main-process text (#408)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-command-errors-'))
    try {
      writeFixture(root, 'src/services/workflows/commands/legacy-character-roster-repair.command.ts', `
        const text = (zh: string, en: string) => zh || en
        export async function run(result: { success: boolean; error?: string }, mismatch: boolean) {
          if (mismatch) throw new Error('LEGACY_ROSTER_PROJECT_MISMATCH')
          if (!result.success) throw new Error(result.error || text('修复失败', 'The repair failed.'))
          throw new Error('旧版角色名单已变更')
        }
        export function localized(cause: unknown) {
          if (cause) throw cause
          throw new Error(text('当前项目已切换', 'The project changed.'))
        }
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      const lines = result.output.split(/\r?\n/).filter(line => line.includes('[thrown-error]'))
      expect(lines).toHaveLength(3)
      expect(lines.join(' ')).toContain('LEGACY_ROSTER_PROJECT_MISMATCH')
      expect(lines.join(' ')).toContain('result.error')
      expect(lines.join(' ')).toContain('旧版角色名单已变更')
      expect(result.output).not.toContain('当前项目已切换')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects Chinese-only and forwarded errors in every workflow command file, while stable error codes stay to the error-code registry (#466)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-all-command-errors-'))
    try {
      writeFixture(root, 'src/services/workflows/commands/generate-draft.command.ts', `
        declare const context: { uiLocale: 'zh-CN' | 'en-US' }
        declare function workflowUiText(context: unknown, zh: string, en: string): string
        const uiText = (zh: string, en: string) => workflowUiText(context, zh, en)
        export function run(result: { error?: string }, step: number) {
          if (step === 1) throw new Error('定稿后处理缺少冻结工作流上下文')
          if (step === 2) throw new Error(result.error || uiText('保存失败', 'Saving failed.'))
          if (step === 3) throw new Error('GENERATION_DRAFT_RECEIPT_INVALID')
          if (step === 4) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
          throw new Error(uiText('当前项目已切换', 'The project changed.'))
        }
      `)
      writeFixture(root, 'src/services/workflows/commands/__tests__/generate-draft.test.ts', `
        throw new Error('测试里的中文不进界面')
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      const lines = result.output.split(/\r?\n/).filter(line => line.includes('[thrown-error]'))
      expect(lines).toHaveLength(2)
      expect(lines.join(' ')).toContain('定稿后处理缺少冻结工作流上下文')
      expect(lines.join(' ')).toContain('result.error')
      expect(result.output).not.toContain('GENERATION_DRAFT_RECEIPT_INVALID')
      expect(result.output).not.toContain('测试里的中文')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects Chinese-only errors thrown anywhere under the workflows directory, translated or not (#471)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-i18n-workflow-errors-'))
    try {
      writeFixture(root, 'src/services/workflows/directory-workflow.ts', `
        declare function localeText(locale: string, zh: string, en: string): string
        declare function textForLocale(locale: string, zh: string, en: string): string
        export function run(result: { error?: string }, guard: { message?: string }, locale: string, step: number) {
          if (step === 1) throw new Error('蓝图保存后验证失败')
          if (step === 2) throw new Error(result.error || '提交章节蓝图失败')
          if (step === 3) throw new Error(locale === 'en-US' ? 'Not ready.' : guard.message || '前置条件未满足')
          if (step === 4) throw new Error(localeText(locale, '批量创作已取消', 'Batch writing was cancelled.'))
          if (step === 5) throw new Error(textForLocale(locale, '当前项目已切换', 'The project changed.'))
          if (step === 6) throw new Error(guard.message || localeText(locale, '前置条件未满足', 'Prerequisites are not met.'))
          throw new Error('DIRECTORY_PROGRESS_NOT_FOUND')
        }
      `)
      writeFixture(root, 'src/services/workflows/__tests__/directory-workflow.test.ts', `
        throw new Error('测试里的中文不进界面')
      `)

      const result = runChecker(root)

      expect(result.status).toBe(1)
      const lines = result.output.split(/\r?\n/).filter(line => line.includes('[thrown-error]'))
      expect(lines.map(line => line.replace(/^.*\[thrown-error\] /u, ''))).toEqual([
        "'蓝图保存后验证失败'",
        "result.error || '提交章节蓝图失败'",
        "locale === 'en-US' ? 'Not ready.' : guard.message || '前置条件未满足'",
      ])
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
