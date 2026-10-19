import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_INSTALLED_SKILL_CASES,
  masterInspectWritingSkillMarkdown,
  masterVisibleFields,
  plantLegacyInstalledSkill,
} from '../../../test/helpers/installed-writing-skill-fixture'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  pickedPaths: [] as string[],
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: mocks.pickedPaths.length === 0, filePaths: mocks.pickedPaths })) },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)) },
}))
vi.mock('../../i18n', () => ({ mainText: (_locale: string, _zh: string, en: string) => en }))
// 设置页经由 Skill 注册中心读取 skills:list-user；这里把渲染层的 IPC 直接接到主进程处理器上。
vi.mock('../../../src/services/ipc-client', () => ({
  ipc: { invoke: (channel: string, ...args: unknown[]) => handler(channel)({}, ...args) },
}))
vi.mock('../../../src/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: null }) },
}))

let fixtureRoot = ''
let velaHome: string

function handler(channel: string): IpcHandler {
  const result = mocks.handlers.get(channel)
  if (!result) throw new Error(`Missing IPC handler: ${channel}`)
  return result
}

function skillResponse(body = `---
name: safe-prose
description: Improve concrete prose.
version: 1.0.0
language: en-US
stage: refinement
---
Revise with concrete action and varied sentence rhythm.`): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })
}

const sourceUrl = 'https://github.com/acme/story-skill/blob/main/SKILL.md'
const rendererEvent = { sender: { id: 7, isDestroyed: () => false } }
let pickRoot = ''

function writeLocalSkill(folder: string, files: Record<string, string>): string {
  const root = path.join(pickRoot, folder)
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), content)
  }
  return root
}

type PickResult = {
  success: boolean
  cancelled?: boolean
  error?: string
  inspection?: { candidateId: string; compatible: boolean; reasons: string[]; utf8Bytes: number; bundledFiles: string[]; unbundledReferences: string[]; skippedFiles: string[] }
}

async function pickLocal(kind: 'file' | 'folder', picked: string): Promise<PickResult> {
  mocks.pickedPaths = [picked]
  return await handler('skills:pick-local')(rendererEvent, kind) as PickResult
}

function installLocal(candidateId: string) {
  return handler('skills:install-local')(rendererEvent, candidateId)
}

const agentSkill = `---
name: scene-voice
description: >-
  Keep each scene in a consistent narrative voice.
  Use when drafting or revising chapters.
license: Apache-2.0
metadata:
  author: acme
---
Follow the voice rules in [the voice guide](references/voice.md).
See also \`references/pacing.md\`.`

/** 设置页看到的已安装 Skill：经注册中心解析 skills:list-user 的结果。 */
async function settingsView(id: string) {
  const { skillRegistry } = await import('../../../src/services/agent/skill-registry')
  await skillRegistry.loadAll()
  return skillRegistry.getById(id)
}

async function inspectThenInstall(url = sourceUrl) {
  const inspected = await handler('skills:inspect-github')({}, url) as {
    success: boolean
    inspection?: { contentSha256?: string }
  }
  expect(inspected).toMatchObject({
    success: true,
    inspection: { contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
  })
  return handler('skills:install-github')({}, url)
}

describe('writing skill app-data boundary', () => {
  beforeEach(async () => {
    vi.resetModules()
    mocks.handlers.clear()
    velaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-writing-skills-'))
    fixtureRoot = velaHome
    pickRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-skill-pick-'))
    mocks.pickedPaths = []
    velaHome = await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(fixtureRoot)
    vi.stubGlobal('fetch', vi.fn(async () => skillResponse()))
    const { registerAppDataController } = await import('../app-data-controller')
    registerAppDataController()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.AI_NOVEL_VELA_HOME
    delete process.env.AI_NOVEL_APP_DATA_HOME
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
    fs.rmSync(pickRoot, { recursive: true, force: true })
  })

  it('imports a generic Agent Skill folder and merges the references it cites', async () => {
    const folder = writeLocalSkill('scene-voice', {
      'SKILL.md': agentSkill,
      'references/voice.md': 'Stay in close third person.',
      'references/pacing.md': 'Alternate long and short scenes.',
      'references/unused.md': 'Never cited.',
      'scripts/lint.py': 'print(1)',
      'assets/cover.png': '\u0089PNG',
    })
    const picked = await pickLocal('folder', folder)
    expect(picked).toMatchObject({
      success: true,
      inspection: {
        compatible: true,
        metadata: { name: 'scene-voice', description: 'Keep each scene in a consistent narrative voice. Use when drafting or revising chapters.' },
        bundledFiles: ['references/voice.md', 'references/pacing.md'],
      },
    })
    expect(picked.inspection!.skippedFiles.sort()).toEqual(['assets/cover.png', 'references/unused.md', 'scripts/lint.py'])
    expect(fs.existsSync(path.join(velaHome, 'skills', 'scene-voice'))).toBe(false)

    await expect(installLocal(picked.inspection!.candidateId)).resolves.toMatchObject({ success: true, skill: { name: 'scene-voice' } })
    const installed = path.join(velaHome, 'skills', 'scene-voice')
    expect(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8')).toBe(agentSkill)
    expect(fs.readFileSync(path.join(installed, 'references', 'voice.md'), 'utf8')).toBe('Stay in close third person.')
    expect(fs.existsSync(path.join(installed, 'references', 'unused.md'))).toBe(false)
    expect(fs.existsSync(path.join(installed, 'scripts'))).toBe(false)
    expect(fetch).not.toHaveBeenCalled()

    const listed = await handler('skills:list-user')({}) as Array<{ name: string; bundle: unknown }>
    expect(listed).toEqual([expect.objectContaining({
      name: 'scene-voice',
      bundle: {
        status: 'intact',
        files: [
          { path: 'references/voice.md', content: 'Stay in close third person.' },
          { path: 'references/pacing.md', content: 'Alternate long and short scenes.' },
        ],
      },
    })])
    const shown = await settingsView('user:scene-voice')
    expect(shown?.writingSkill).toMatchObject({
      compatible: true,
      bundledFiles: ['references/voice.md', 'references/pacing.md'],
      utf8Bytes: picked.inspection!.utf8Bytes,
      metadata: { description: 'Keep each scene in a consistent narrative voice. Use when drafting or revising chapters.' },
    })
  })

  it.each([
    ['a changed reference file', (installed: string) => fs.writeFileSync(path.join(installed, 'references', 'voice.md'), 'Edited by hand.')],
    ['a deleted reference file', (installed: string) => fs.rmSync(path.join(installed, 'references', 'voice.md'))],
    ['a reference file replaced by a hard link', (installed: string) => {
      const outside = path.join(pickRoot, 'hard-voice.md')
      fs.writeFileSync(outside, 'Stay in close third person.')
      fs.rmSync(path.join(installed, 'references', 'voice.md'))
      fs.linkSync(outside, path.join(installed, 'references', 'voice.md'))
    }],
    ['a references folder replaced by a junction', (installed: string) => {
      const outside = writeLocalSkill('junction-target', { 'voice.md': 'Stay in close third person.', 'pacing.md': 'Alternate long and short scenes.' })
      fs.rmSync(path.join(installed, 'references'), { recursive: true })
      fs.symlinkSync(outside, path.join(installed, 'references'), process.platform === 'win32' ? 'junction' : 'dir')
    }],
    ['an unreadable manifest', (installed: string) => fs.writeFileSync(path.join(installed, '.pagekin-bundle.json'), '{')],
    ['a manifest that points outside the skill', (installed: string) => fs.writeFileSync(
      path.join(installed, '.pagekin-bundle.json'),
      JSON.stringify({ version: 1, files: [{ path: '../outside.md', sha256: '0'.repeat(64) }] }),
    )],
  ])('lists an installed folder skill with %s as damaged and unbindable', async (_label, damage) => {
    const folder = writeLocalSkill('scene-voice', {
      'SKILL.md': agentSkill,
      'references/voice.md': 'Stay in close third person.',
      'references/pacing.md': 'Alternate long and short scenes.',
    })
    const picked = await pickLocal('folder', folder)
    await expect(installLocal(picked.inspection!.candidateId)).resolves.toMatchObject({ success: true })
    damage(path.join(velaHome, 'skills', 'scene-voice'))

    const shown = await settingsView('user:scene-voice')
    expect(shown?.writingSkill).toMatchObject({ compatible: false, reasons: expect.arrayContaining(['bundle-damaged']) })
  })

  it('imports a single SKILL.md file and names a nameless one after its file', async () => {
    const file = path.join(writeLocalSkill('downloads', { 'quiet-prose.md': 'Prefer plain verbs.' }), 'quiet-prose.md')
    const picked = await pickLocal('file', file)
    expect(picked).toMatchObject({ success: true, inspection: { compatible: true, metadata: { name: 'quiet-prose' } } })
    await expect(installLocal(picked.inspection!.candidateId)).resolves.toMatchObject({ success: true })
    expect(fs.readFileSync(path.join(velaHome, 'skills', 'quiet-prose', 'SKILL.md'), 'utf8')).toBe('Prefer plain verbs.')
    expect((await settingsView('user:quiet-prose'))?.writingSkill).toMatchObject({ compatible: true, bundledFiles: [] })
  })

  it('marks a single file that cites reference files as incompatible', async () => {
    const folder = writeLocalSkill('scene-voice', { 'SKILL.md': agentSkill, 'references/voice.md': 'x', 'references/pacing.md': 'y' })
    const picked = await pickLocal('file', path.join(folder, 'SKILL.md'))
    expect(picked).toMatchObject({ success: true, inspection: { compatible: false, reasons: ['relative-reference'], bundledFiles: [] } })
    await expect(installLocal(picked.inspection!.candidateId)).resolves.toMatchObject({ success: false })
    expect(fs.existsSync(path.join(velaHome, 'skills', 'scene-voice'))).toBe(false)
  })

  it('installs a folder whose plain links point at files it cannot ship and reports them', async () => {
    const folder = writeLocalSkill('forms', {
      'SKILL.md': '---\nname: forms\n---\nFill [the form](FORMS.md) and match ![](image.png).',
      'image.png': '\u0089PNG',
    })
    const picked = await pickLocal('folder', folder)
    expect(picked).toMatchObject({
      success: true,
      inspection: { compatible: true, reasons: [], bundledFiles: [], unbundledReferences: ['FORMS.md', 'image.png'], skippedFiles: ['image.png'] },
    })
    await expect(installLocal(picked.inspection!.candidateId)).resolves.toMatchObject({ success: true, skill: { name: 'forms' } })
    expect(fs.readdirSync(path.join(velaHome, 'skills', 'forms')).sort()).toEqual(['.pagekin-bundle.json', 'SKILL.md'])
  })

  it('installs a folder whose reference file links back to SKILL.md and keeps the body once', async () => {
    const skill = '---\nname: backlink\n---\nOpening rules. Read [voice](references/voice.md).'
    const folder = writeLocalSkill('backlink', { 'SKILL.md': skill, 'references/voice.md': 'Close third. [Back](../SKILL.md)' })
    const picked = await pickLocal('folder', folder)
    expect(picked).toMatchObject({
      success: true,
      inspection: { compatible: true, bundledFiles: ['references/voice.md'], unbundledReferences: [], skippedFiles: [] },
    })

    await expect(installLocal(picked.inspection!.candidateId)).resolves.toMatchObject({ success: true, skill: { name: 'backlink' } })
    expect(fs.readFileSync(path.join(velaHome, 'skills', 'backlink', 'SKILL.md'), 'utf8')).toBe(skill)
    const listed = await handler('skills:list-user')({}) as Array<{ name: string; bundle: unknown }>
    expect(listed).toEqual([expect.objectContaining({
      name: 'backlink',
      bundle: { status: 'intact', files: [{ path: 'references/voice.md', content: 'Close third. [Back](../SKILL.md)' }] },
    })])
  })

  it('installs a file cited in two letter cases once', async () => {
    const folder = writeLocalSkill('cased', {
      'SKILL.md': '---\nname: cased\n---\nRead references/voice.md, then [voice](References/Voice.md).',
      'references/voice.md': 'Close third.',
    })
    const picked = await pickLocal('folder', folder)
    expect(picked).toMatchObject({ success: true, inspection: { compatible: true, bundledFiles: ['references/voice.md'], skippedFiles: [] } })

    await expect(installLocal(picked.inspection!.candidateId)).resolves.toMatchObject({ success: true, skill: { name: 'cased' } })
    expect(fs.readdirSync(path.join(velaHome, 'skills', 'cased', 'references'))).toEqual(['voice.md'])
  })

  it('reports a failed file write in plain words and leaves nothing installed', async () => {
    const folder = writeLocalSkill('scene-voice', { 'SKILL.md': agentSkill, 'references/voice.md': 'x', 'references/pacing.md': 'y' })
    const picked = await pickLocal('folder', folder)
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).endsWith('pacing.md')) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(args[0])}'`), { code: 'EACCES' })
      }
      return write(...args)
    })

    const result = await installLocal(picked.inspection!.candidateId) as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/EACCES|permission denied|[\\/]/u)
    expect(result.error).toMatch(/inspect the skill again to retry/iu)
    expect(fs.existsSync(path.join(velaHome, 'skills', 'scene-voice'))).toBe(false)
  })

  it('never bundles a reference that escapes the skill folder', async () => {
    writeLocalSkill('', { 'secret.md': 'outside the skill' })
    const folder = writeLocalSkill('escape', { 'SKILL.md': '---\nname: escape\n---\nRead [this](../secret.md).' })
    const picked = await pickLocal('folder', folder)
    expect(picked).toMatchObject({ success: true, inspection: { compatible: false, reasons: ['relative-reference'], bundledFiles: [] } })
    await expect(installLocal(picked.inspection!.candidateId)).resolves.toMatchObject({ success: false })
    expect(fs.existsSync(path.join(velaHome, 'skills', 'escape'))).toBe(false)
  })

  it('rejects a skill folder that contains a symbolic link', async () => {
    const outside = writeLocalSkill('outside', { 'voice.md': 'linked' })
    const folder = writeLocalSkill('linked', { 'SKILL.md': '---\nname: linked\n---\nRead references/voice.md.' })
    fs.symlinkSync(outside, path.join(folder, 'references'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(pickLocal('folder', folder)).resolves.toMatchObject({ success: false, error: expect.stringMatching(/symbolic link/u) })
    expect(fs.existsSync(path.join(velaHome, 'skills', 'linked'))).toBe(false)
  })

  it.each([
    ['an oversized SKILL.md', { 'SKILL.md': `---\nname: huge\n---\n${'x'.repeat(65 * 1024)}` }, /64 KiB/u],
    ['a folder without SKILL.md', { 'README.md': 'not a skill' }, /no SKILL\.md/u],
    ['an invalid skill name', { 'SKILL.md': '---\nname: My Skill\n---\nWrite.' }, /name "My Skill" is invalid/u],
  ])('rejects %s before anything is written', async (_label, files, message) => {
    const picked = await pickLocal('folder', writeLocalSkill('bad', files))
    expect(picked).toMatchObject({ success: false, error: expect.stringMatching(message) })
    expect(fs.existsSync(path.join(velaHome, 'skills'))).toBe(false)
  })

  it('marks merged content over 64 KiB as incompatible', async () => {
    const folder = writeLocalSkill('big', {
      'SKILL.md': '---\nname: big\n---\nRead references/a.md and references/b.md.',
      'references/a.md': 'a'.repeat(40 * 1024),
      'references/b.md': 'b'.repeat(40 * 1024),
    })
    await expect(pickLocal('folder', folder)).resolves.toMatchObject({
      success: true,
      inspection: { compatible: false, reasons: ['content-too-large'] },
    })
  })

  it('rejects installation when the folder changed after inspection', async () => {
    const folder = writeLocalSkill('scene-voice', { 'SKILL.md': agentSkill, 'references/voice.md': 'v1', 'references/pacing.md': 'p' })
    const picked = await pickLocal('folder', folder)
    fs.writeFileSync(path.join(folder, 'references', 'voice.md'), 'v2')
    await expect(installLocal(picked.inspection!.candidateId)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/changed after inspection/u),
    })
    expect(fs.existsSync(path.join(velaHome, 'skills', 'scene-voice'))).toBe(false)
  })

  it('installs only the latest inspected local candidate, once, for the renderer that picked it', async () => {
    const first = await pickLocal('file', path.join(writeLocalSkill('a', { 'first.md': 'One.' }), 'first.md'))
    const second = await pickLocal('file', path.join(writeLocalSkill('b', { 'second.md': 'Two.' }), 'second.md'))
    await expect(installLocal(first.inspection!.candidateId)).resolves.toMatchObject({ success: false })
    await expect(handler('skills:install-local')({}, second.inspection!.candidateId)).resolves.toMatchObject({ success: false })
    await expect(installLocal(second.inspection!.candidateId)).resolves.toMatchObject({ success: true })
    await expect(installLocal(second.inspection!.candidateId)).resolves.toMatchObject({ success: false })
    expect(fs.existsSync(path.join(velaHome, 'skills', 'first'))).toBe(false)
  })

  it('keeps the pending candidate when a later dialog is dismissed', async () => {
    const picked = await pickLocal('file', path.join(writeLocalSkill('a', { 'kept.md': 'Kept.' }), 'kept.md'))
    mocks.pickedPaths = []
    await expect(handler('skills:pick-local')(rendererEvent, 'folder')).resolves.toEqual({ success: true, cancelled: true })
    await expect(installLocal(picked.inspection!.candidateId)).resolves.toMatchObject({ success: true, skill: { name: 'kept' } })
  })

  it('inspects a GitHub blob without writing it', async () => {
    await expect(handler('skills:inspect-github')({}, sourceUrl)).resolves.toMatchObject({
      success: true,
      inspection: {
        sourceUrl,
        compatible: true,
        metadata: { name: 'safe-prose' },
        suggestedStage: 'refinement',
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    })
    expect(fs.existsSync(path.join(velaHome, 'skills'))).toBe(false)
  })

  it('refetches and installs only after the write channel is called', async () => {
    await expect(inspectThenInstall()).resolves.toMatchObject({
      success: true,
      skill: { name: 'safe-prose', source: 'user' },
    })
    expect(fs.readFileSync(path.join(velaHome, 'skills', 'safe-prose', 'SKILL.md'), 'utf8'))
      .toContain('Revise with concrete action')
  })

  it('rejects incompatible content and never writes it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => skillResponse(`---
name: unsafe-prose
description: Runs code
---
Run scripts/rewrite.py.`)))

    const unsafeUrl = 'https://github.com/acme/unsafe/blob/main/SKILL.md'
    await handler('skills:inspect-github')({}, unsafeUrl)
    await expect(handler('skills:install-github')({}, unsafeUrl))
      .resolves.toMatchObject({ success: false })
    expect(fs.existsSync(path.join(velaHome, 'skills', 'unsafe-prose'))).toBe(false)
  })

  it('rejects a pre-existing symlinked skill target instead of writing outside app data', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-writing-skill-outside-'))
    const skillsRoot = path.join(velaHome, 'skills')
    fs.mkdirSync(skillsRoot, { recursive: true })
    fs.symlinkSync(outside, path.join(skillsRoot, 'safe-prose'), process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await handler('skills:inspect-github')({}, sourceUrl)
      await expect(handler('skills:install-github')({}, sourceUrl))
        .resolves.toMatchObject({ success: false })
      expect(fs.existsSync(path.join(outside, 'SKILL.md'))).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked skills root instead of following an app-data ancestor', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-writing-skill-root-'))
    fs.symlinkSync(outside, path.join(velaHome, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await handler('skills:inspect-github')({}, sourceUrl)
      await expect(handler('skills:install-github')({}, sourceUrl))
        .resolves.toMatchObject({ success: false })
      expect(fs.existsSync(path.join(outside, 'safe-prose', 'SKILL.md'))).toBe(false)
      fs.mkdirSync(path.join(outside, 'safe-prose'), { recursive: true })
      fs.writeFileSync(path.join(outside, 'safe-prose', 'SKILL.md'), 'outside', 'utf8')
      await expect(handler('skills:uninstall-user')({}, 'safe-prose')).resolves.toMatchObject({ success: false })
      expect(fs.existsSync(path.join(outside, 'safe-prose', 'SKILL.md'))).toBe(true)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it.each([
    'https://example.com/skill.md',
    'https://github.com/acme/repo/issues/1',
    'https://github.com/acme/%2e%2e/blob/main/SKILL.md',
  ])('rejects source outside the supported GitHub forms: %s', async (sourceUrl) => {
    await expect(handler('skills:inspect-github')({}, sourceUrl)).resolves.toMatchObject({ success: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uninstalls only a validated user skill directory', async () => {
    await inspectThenInstall()
    await expect(handler('skills:uninstall-user')({}, 'safe-prose')).resolves.toEqual({ success: true })
    expect(fs.existsSync(path.join(velaHome, 'skills', 'safe-prose'))).toBe(false)
    await expect(handler('skills:uninstall-user')({}, '../prompts')).resolves.toMatchObject({ success: false })
  })

  it('rejects installation without a matching read-only inspection', async () => {
    await expect(handler('skills:install-github')({}, sourceUrl)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/inspect|检查/ui),
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects when SKILL.md changes between inspection and confirmed installation', async () => {
    const first = skillResponse()
    const changed = skillResponse(`---
name: safe-prose
description: Changed after inspection.
stage: refinement
---
Different content.`)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(changed))

    await handler('skills:inspect-github')({}, sourceUrl)
    await expect(handler('skills:install-github')({}, sourceUrl)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/changed|变化/ui),
    })
    expect(fs.existsSync(path.join(velaHome, 'skills', 'safe-prose'))).toBe(false)
  })

  it('rejects a second install instead of overwriting an existing same-named user skill', async () => {
    await inspectThenInstall()
    await handler('skills:inspect-github')({}, sourceUrl)
    await expect(handler('skills:install-github')({}, sourceUrl)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/already installed|已安装/ui),
    })
    expect(fs.readFileSync(path.join(velaHome, 'skills', 'safe-prose', 'SKILL.md'), 'utf8'))
      .toContain('Revise with concrete action')
  })

  it('installs quoted frontmatter under the normalized bindable id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => skillResponse(`---
name: "quoted-prose"
description: "Quoted metadata"
stage: "refinement"
---
Keep concrete action.`)))

    await expect(inspectThenInstall()).resolves.toMatchObject({
      success: true,
      skill: { name: 'quoted-prose' },
    })
    expect(fs.existsSync(path.join(velaHome, 'skills', 'quoted-prose', 'SKILL.md'))).toBe(true)
    await expect(handler('skills:uninstall-user')({}, 'quoted-prose')).resolves.toEqual({ success: true })
  })

  it.each(LEGACY_INSTALLED_SKILL_CASES)('shows a skill installed without a manifest exactly as master did: $label', async (testCase) => {
    plantLegacyInstalledSkill(path.join(velaHome, 'skills'), path.join(pickRoot, 'outside'), testCase)

    const skill = await settingsView(`user:${testCase.name}`)

    const master = masterInspectWritingSkillMarkdown(testCase.skill)
    expect(masterVisibleFields(skill?.writingSkill)).toEqual(master)
    expect(skill?.content).toBe(master.content)
  })
})
