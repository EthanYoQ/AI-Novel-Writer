import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import { ipc } from '../ipc-client'
import {
  BUILTIN_PROMPTS,
  clearProjectCustomPrompts,
  EDITABLE_PROMPT_KEYS,
  getPromptTemplate,
  getPromptVariableDescription,
  loadProjectCustomPrompts,
  PROMPT_VARIABLE_DESCRIPTIONS_EN,
  saveProjectCustomPrompt,
  type PromptTemplate,
} from '../prompt-templates'

vi.mock('../ipc-client', () => ({
  ipc: {
    invoke: vi.fn(),
    invokeWithProjectSession: vi.fn(),
  },
}))

const sessionA: ProjectSessionContext = {
  projectId: 'project-a',
  leaseId: 'lease-a',
  projectPath: 'C:/novels/project-a',
}

const sessionB: ProjectSessionContext = {
  projectId: 'project-b',
  leaseId: 'lease-b',
  projectPath: 'C:/novels/project-b',
}

const replacementSessionA: ProjectSessionContext = {
  ...sessionA,
  leaseId: 'lease-a-reopened',
}

function customTemplate(content: string): PromptTemplate {
  return {
    key: 'first_chapter_draft',
    name: '第一章草稿',
    description: '项目覆盖',
    variables: {},
    content,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function sourceFilesAt(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFilesAt(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearProjectCustomPrompts()
  setActiveProjectSessionContext(sessionA)
})

afterEach(() => {
  clearProjectCustomPrompts()
  setActiveProjectSessionContext(null)
})

describe('project custom prompt session ownership', () => {
  it.each([
    ['zh-CN', true],
    ['en-US', false],
  ] as const)('%s project save migrates the untagged file only for Chinese', async (writingLanguage, migratesLegacy) => {
    const legacyPath = `${sessionA.projectPath}/.vela/prompts/first_chapter_draft.json`
    const localizedPath = `${sessionA.projectPath}/.vela/prompts/first_chapter_draft.${writingLanguage}.json`
    const files = new Map<string, string>([[legacyPath, '{invalid json']])
    vi.mocked(ipc.invoke).mockResolvedValue({ templates: [], diagnostics: [] } as never)
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (
      _session: ProjectSessionContext,
      channel: string,
      ...args: unknown[]
    ) => {
      if (channel === 'fs:check-exists') {
        const target = String(args[0])
        return target.endsWith('/.vela/prompts') || files.has(target)
      }
      if (channel === 'fs:list-dir') return [...files.keys()].map(filePath => ({
        name: filePath.slice(filePath.lastIndexOf('/') + 1),
        path: filePath,
        isDir: false,
      }))
      if (channel === 'fs:read-file') return { success: true, content: files.get(String(args[0])) ?? '' }
      if (channel === 'fs:write-file') {
        files.set(String(args[0]), String(args[1]))
        return { success: true }
      }
      throw new Error(`unexpected channel: ${channel}`)
    }) as never)

    await expect(saveProjectCustomPrompt(sessionA, {
      ...customTemplate('saved prompt'),
      writingLanguage,
    })).resolves.toBe(true)

    expect(files.get(localizedPath)).toContain('saved prompt')
    expect(files.get(legacyPath)).toBe(migratesLegacy ? '' : '{invalid json')
    clearProjectCustomPrompts()
    if (migratesLegacy) {
      await expect(loadProjectCustomPrompts(sessionA, 'zh-CN')).resolves.toBe(true)
    } else {
      await expect(loadProjectCustomPrompts(sessionA, 'zh-CN')).rejects.toThrow(legacyPath)
    }
  })

  it('does not let a delayed project A load overwrite the completed project B cache', async () => {
    const delayedARead = deferred<{ success: boolean; content: string }>()
    const aReadStarted = deferred<void>()

    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (
      session: ProjectSessionContext,
      channel: string,
    ) => {
      if (channel === 'fs:check-exists') return true
      if (channel === 'fs:list-dir') {
        return [{
          name: 'first_chapter_draft.json',
          path: `${session.projectPath}/.vela/prompts/first_chapter_draft.json`,
          isDir: false,
          size: 1,
          modifiedAt: '',
        }]
      }
      if (channel === 'fs:read-file' && session.projectId === sessionA.projectId) {
        aReadStarted.resolve()
        return delayedARead.promise
      }
      if (channel === 'fs:read-file') {
        return { success: true, content: JSON.stringify(customTemplate('project B override')) }
      }
      throw new Error(`unexpected channel: ${channel}`)
    }) as never)

    const loadA = loadProjectCustomPrompts(sessionA)
    await aReadStarted.promise

    setActiveProjectSessionContext(sessionB)
    await expect(loadProjectCustomPrompts(sessionB)).resolves.toBe(true)
    expect(getPromptTemplate('first_chapter_draft', sessionB)?.content).toBe('project B override')

    delayedARead.resolve({ success: true, content: JSON.stringify(customTemplate('project A override')) })
    await expect(loadA).resolves.toBe(false)

    expect(getPromptTemplate('first_chapter_draft', sessionB)?.content).toBe('project B override')
    expect(getPromptTemplate('first_chapter_draft', sessionA)?.content).not.toBe('project A override')
  })

  it('fails closed when the same project path is reopened with a new lease', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (
      session: ProjectSessionContext,
      channel: string,
    ) => {
      if (channel === 'fs:check-exists') return true
      if (channel === 'fs:list-dir') {
        return [{
          name: 'first_chapter_draft.json',
          path: `${session.projectPath}/.vela/prompts/first_chapter_draft.json`,
          isDir: false,
          size: 1,
          modifiedAt: '',
        }]
      }
      if (channel === 'fs:read-file') {
        return {
          success: true,
          content: JSON.stringify(customTemplate(`override for ${session.leaseId}`)),
        }
      }
      throw new Error(`unexpected channel: ${channel}`)
    }) as never)

    await expect(loadProjectCustomPrompts(sessionA)).resolves.toBe(true)
    expect(getPromptTemplate('first_chapter_draft', sessionA)?.content).toBe('override for lease-a')

    setActiveProjectSessionContext(replacementSessionA)
    expect(getPromptTemplate('first_chapter_draft', replacementSessionA)?.content).not.toBe('override for lease-a')
    expect(getPromptTemplate('first_chapter_draft', sessionA)?.content).not.toBe('override for lease-a')

    await expect(loadProjectCustomPrompts(replacementSessionA)).resolves.toBe(true)
    expect(getPromptTemplate('first_chapter_draft', replacementSessionA)?.content)
      .toBe('override for lease-a-reopened')
  })

  it('isolates one damaged project prompt while publishing the remaining valid overrides', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (
      session: ProjectSessionContext,
      channel: string,
      ...args: unknown[]
    ) => {
      if (channel === 'fs:check-exists') return true
      if (channel === 'fs:list-dir') {
        return [
          {
            name: 'first_chapter_draft.json',
            path: `${session.projectPath}/.vela/prompts/first_chapter_draft.json`,
            isDir: false,
            size: 1,
            modifiedAt: '',
          },
          {
            name: 'next_chapter_draft.json',
            path: `${session.projectPath}/.vela/prompts/next_chapter_draft.json`,
            isDir: false,
            size: 1,
            modifiedAt: '',
          },
        ]
      }
      if (channel === 'fs:read-file' && String(args[0]).includes('first_chapter')) {
        return { success: true, content: JSON.stringify(customTemplate('partial override')) }
      }
      if (channel === 'fs:read-file') {
        return { success: false, content: '', error: 'injected read failure' }
      }
      throw new Error(`unexpected channel: ${channel}`)
    }) as never)

    await expect(loadProjectCustomPrompts(sessionA)).rejects.toThrow('next_chapter_draft.json')

    expect(getPromptTemplate('first_chapter_draft', sessionA)?.content).toBe('partial override')
    expect(ipc.invokeWithProjectSession).toHaveBeenCalledWith(
      sessionA,
      'fs:check-exists',
      `${sessionA.projectPath}/.vela/prompts`,
      sessionA.projectPath,
    )
    expect(vi.mocked(ipc.invokeWithProjectSession).mock.calls.every(([owner]) => (
      (owner as ProjectSessionContext).projectId === sessionA.projectId
      && (owner as ProjectSessionContext).leaseId === sessionA.leaseId
      && (owner as ProjectSessionContext).projectPath === sessionA.projectPath
    ))).toBe(true)
  })

  it('does not expose an old owner override to a workflow after its lease becomes stale', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (
      session: ProjectSessionContext,
      channel: string,
    ) => {
      if (channel === 'fs:check-exists') return true
      if (channel === 'fs:list-dir') {
        return [{
          name: 'first_chapter_draft.json',
          path: `${session.projectPath}/.vela/prompts/first_chapter_draft.json`,
          isDir: false,
          size: 1,
          modifiedAt: '',
        }]
      }
      if (channel === 'fs:read-file') {
        return { success: true, content: JSON.stringify(customTemplate('old workflow override')) }
      }
      throw new Error(`unexpected channel: ${channel}`)
    }) as never)

    await expect(loadProjectCustomPrompts(sessionA)).resolves.toBe(true)
    expect(getPromptTemplate('first_chapter_draft', sessionA)?.content).toBe('old workflow override')

    setActiveProjectSessionContext(replacementSessionA)

    expect(getPromptTemplate('first_chapter_draft', sessionA)?.content).not.toBe('old workflow override')
  })

  it('requires every workflow prompt lookup to await catalog hydration with its frozen project session', () => {
    const workflowRoot = join(process.cwd(), 'src/services/workflows')
    const sourceFiles = sourceFilesAt(workflowRoot)
    const unsafeLookups = sourceFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return [...source.matchAll(/(?:getPromptTemplate|resolvePromptTemplate)\(([^)]*)\)/g)]
        .filter((match) => !match[0].startsWith('resolvePromptTemplate') || !match[1].includes('projectSession'))
        .map((match) => `${file}:${source.slice(0, match.index).split('\n').length}`)
    })

    expect(unsafeLookups).toEqual([])
    expect(sourceFiles.some((file) => (
      readFileSync(file, 'utf8').includes('await resolvePromptTemplate(')
    ))).toBe(true)
  })

  it('reloads Prompt settings by full project identity and gates async UI completion', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/settings/PromptSettings.tsx'),
      'utf8',
    )

    expect(source).toContain('captureProjectSession({ id: projectId, path: projectPath, sessionLease: projectLease })')
    expect(source).toContain('loadProjectCustomPrompts(session, editingLanguage)')
    expect(source).toContain('isProjectSessionCurrent(session)')
    expect(source).toContain('[editingLanguage, projectId, projectLease, projectPath, text]')
    expect(source).toContain('getPromptTemplate(builtinTemplate.key, projectSession ?? undefined, editingLanguage)')
    expect(source).toContain('getPromptSource(builtinTemplate.key, projectSession ?? undefined, editingLanguage)')
  })

  it('provides audited English descriptions for every variable shown by editable prompts', () => {
    const editableTemplates = BUILTIN_PROMPTS.filter((template) => EDITABLE_PROMPT_KEYS.includes(template.key))

    for (const template of editableTemplates) {
      for (const variableName of Object.keys(template.variables)) {
        expect(PROMPT_VARIABLE_DESCRIPTIONS_EN, `${template.key}.${variableName}`).toHaveProperty(variableName)
        expect(getPromptVariableDescription(template, variableName, 'en-US')).toMatch(/[A-Za-z]/)
        expect(getPromptVariableDescription(template, variableName, 'en-US')).not.toMatch(/\p{Script=Han}/u)
        expect(getPromptVariableDescription(template, variableName, 'zh-CN'))
          .toBe(template.variables[variableName])
      }
    }

    expect(getPromptVariableDescription(
      BUILTIN_PROMPTS.find((template) => template.key === 'generate_global_config')!,
      'user_idea',
      'en-US',
    )).toBe('Idea or premise provided by the author')
    expect(getPromptVariableDescription(
      BUILTIN_PROMPTS.find((template) => template.key === 'next_chapter_draft')!,
      'filtered_context',
      'en-US',
    )).toBe('Knowledge-base search results')
    expect(getPromptVariableDescription(
      BUILTIN_PROMPTS.find((template) => template.key === 'consistency_check')!,
      'review_focus',
      'en-US',
    )).toBe('Review areas requested by the author (optional)')
  })
})
