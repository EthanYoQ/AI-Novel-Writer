import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)) },
}))

let localSkillRoots: string[] = []

function writeLocalSkill(body: string, fileName = 'SKILL.md'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-local-skill-'))
  localSkillRoots.push(root)
  const filePath = path.join(root, fileName)
  fs.writeFileSync(filePath, body, 'utf8')
  return filePath
}

const localSkillBody = `---
name: local-prose
description: Local prose refinement.
version: 2.0.0
language: en-US
stage: refinement
---
Revise with concrete action and varied sentence rhythm.`
vi.mock('../../i18n', () => ({ mainText: (_locale: string, _zh: string, en: string) => en }))

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
    mocks.showOpenDialog.mockReset()
    localSkillRoots = []
    velaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-writing-skills-'))
    process.env.AI_NOVEL_VELA_HOME = velaHome
    vi.stubGlobal('fetch', vi.fn(async () => skillResponse()))
    const { registerAppDataController } = await import('../app-data-controller')
    registerAppDataController()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.AI_NOVEL_VELA_HOME
    fs.rmSync(velaHome, { recursive: true, force: true })
    for (const root of localSkillRoots) fs.rmSync(root, { recursive: true, force: true })
    localSkillRoots = []
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

  describe('local SKILL.md import', () => {
    it('picks a local file and returns its path without inspecting it yet', async () => {
      const filePath = writeLocalSkill(localSkillBody)
      mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

      await expect(handler('skills:pick-local-file')({})).resolves.toEqual({ success: true, filePath })
      // 选文件本身不得触发任何检查或写入。
      expect(fs.existsSync(path.join(velaHome, 'skills'))).toBe(false)
    })

    it('treats a cancelled local picker as a no-op instead of an error', async () => {
      mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

      await expect(handler('skills:pick-local-file')({})).resolves.toEqual({ success: true, cancelled: true })
      expect(fs.existsSync(path.join(velaHome, 'skills'))).toBe(false)
    })

    it('inspects the given local path without writing it into app data', async () => {
      const filePath = writeLocalSkill(localSkillBody)

      await expect(handler('skills:inspect-local')({}, filePath)).resolves.toMatchObject({
        success: true,
        inspection: {
          filePath,
          fileName: 'SKILL.md',
          compatible: true,
          metadata: { name: 'local-prose' },
          suggestedStage: 'refinement',
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      })
      expect(fs.existsSync(path.join(velaHome, 'skills'))).toBe(false)
    })

    it('imports the inspected local file only through the confirmed write channel', async () => {
      const filePath = writeLocalSkill(localSkillBody)
      await handler('skills:inspect-local')({}, filePath)

      await expect(handler('skills:install-local')({}, filePath)).resolves.toMatchObject({
        success: true,
        skill: { name: 'local-prose', source: 'user', version: '2.0.0' },
      })
      expect(fs.readFileSync(path.join(velaHome, 'skills', 'local-prose', 'SKILL.md'), 'utf8'))
        .toContain('Revise with concrete action')
    })

    it('runs the same content checks as a remote source and never writes incompatible content', async () => {
      const filePath = writeLocalSkill(`---
name: unsafe-local
description: Runs code
---
Run scripts/rewrite.py.`)

      const inspected = await handler('skills:inspect-local')({}, filePath) as {
        success: boolean
        inspection?: { compatible: boolean; reasons: string[] }
      }
      expect(inspected.success).toBe(true)
      expect(inspected.inspection?.compatible).toBe(false)
      expect(inspected.inspection?.reasons).toContain('script-dependency')

      await expect(handler('skills:install-local')({}, filePath)).resolves.toMatchObject({ success: false })
      expect(fs.existsSync(path.join(velaHome, 'skills', 'unsafe-local'))).toBe(false)
    })

    it('rejects a local file that changed between inspection and import', async () => {
      const filePath = writeLocalSkill(localSkillBody)
      await handler('skills:inspect-local')({}, filePath)
      fs.writeFileSync(filePath, `${localSkillBody}\nAppended after inspection.`, 'utf8')

      await expect(handler('skills:install-local')({}, filePath)).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/changed|变化/ui),
      })
      expect(fs.existsSync(path.join(velaHome, 'skills', 'local-prose'))).toBe(false)
    })

    it('rejects an import without a matching read-only inspection', async () => {
      const filePath = writeLocalSkill(localSkillBody)

      await expect(handler('skills:install-local')({}, filePath)).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/inspect|检查/ui),
      })
      expect(fs.existsSync(path.join(velaHome, 'skills', 'local-prose'))).toBe(false)
    })

    it('rejects a local import that would overwrite an existing same-named user skill', async () => {
      await inspectThenInstall()
      const filePath = writeLocalSkill(`---
name: safe-prose
description: Local replacement
stage: refinement
---
Local replacement body.`)
      await handler('skills:inspect-local')({}, filePath)

      await expect(handler('skills:install-local')({}, filePath)).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/already installed|已安装/ui),
      })
      expect(fs.readFileSync(path.join(velaHome, 'skills', 'safe-prose', 'SKILL.md'), 'utf8'))
        .toContain('Revise with concrete action')
    })

    it('rejects a symlinked local source instead of importing a linked file', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-local-skill-outside-'))
      const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-local-skill-link-'))
      localSkillRoots.push(outside, linkRoot)
      const linkPath = path.join(linkRoot, 'SKILL.md')
      fs.symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

      await expect(handler('skills:inspect-local')({}, linkPath)).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/symlink|符号链接/ui),
      })
      expect(fs.existsSync(path.join(velaHome, 'skills'))).toBe(false)
    })

    it('rejects a local file that is not Markdown', async () => {
      const filePath = writeLocalSkill(localSkillBody, 'skill.txt')

      await expect(handler('skills:inspect-local')({}, filePath)).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/\.md|Markdown/ui),
      })
    })

    it('rejects a local file larger than 64 KiB', async () => {
      const filePath = writeLocalSkill(`${localSkillBody}\n${'x'.repeat(70 * 1024)}`)

      await expect(handler('skills:inspect-local')({}, filePath)).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/64 KiB/ui),
      })
    })

    it('rejects an invalid local path coming from the renderer', async () => {
      await expect(handler('skills:inspect-local')({}, '')).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/path is invalid|路径无效/ui),
      })
    })

    it('derives a stable ASCII identifier for a Chinese skill name', async () => {
      const chineseSkill = `---
name: 通用轻松型网络小说文风
description: 中文写作文风。
language: zh-CN
stage: refinement
---
让句子更具体，动作承担信息。`
      const filePath = writeLocalSkill(chineseSkill)

      const inspected = await handler('skills:inspect-local')({}, filePath) as {
        success: boolean
        inspection: {
          compatible: boolean
          skillId: string
          displayName: string
          declaredName: string
          identifierGenerated: boolean
        }
      }
      expect(inspected.success).toBe(true)
      expect(inspected.inspection).toMatchObject({
        compatible: true,
        declaredName: '通用轻松型网络小说文风',
        displayName: '通用轻松型网络小说文风',
        identifierGenerated: true,
      })
      expect(inspected.inspection.skillId).toMatch(/^skill-[0-9a-f]{8}$/u)

      const skillId = inspected.inspection.skillId
      await expect(handler('skills:install-local')({}, filePath)).resolves.toMatchObject({
        success: true,
        skill: { name: skillId, source: 'user' },
      })

      // 技能库副本：标识符已改写为 ASCII，中文名落到 display_name，正文保持原样。
      const stored = fs.readFileSync(path.join(velaHome, 'skills', skillId, 'SKILL.md'), 'utf8')
      expect(stored).toContain(`name: ${skillId}`)
      expect(stored).toContain('display_name: 通用轻松型网络小说文风')
      expect(stored).toContain('让句子更具体，动作承担信息。')
      // 作者磁盘上的源文件必须一字未改。
      expect(fs.readFileSync(filePath, 'utf8')).toBe(chineseSkill)
    })

    it('derives the same identifier for the same declared name', async () => {
      const body = `---
name: 同一份文风
description: 稳定性检查。
---
正文。`
      const first = writeLocalSkill(body)
      const second = writeLocalSkill(body)

      const a = await handler('skills:inspect-local')({}, first) as { inspection: { skillId: string } }
      const b = await handler('skills:inspect-local')({}, second) as { inspection: { skillId: string } }
      expect(a.inspection.skillId).toBe(b.inspection.skillId)
    })

    it('falls back to the file name when the frontmatter declares no name', async () => {
      const filePath = writeLocalSkill('让句子更具体，动作承担信息。\n', '轻松文风.md')

      const inspected = await handler('skills:inspect-local')({}, filePath) as {
        inspection: { skillId: string; displayName: string; identifierGenerated: boolean }
      }
      expect(inspected.inspection.displayName).toBe('轻松文风')
      expect(inspected.inspection.identifierGenerated).toBe(true)
      expect(inspected.inspection.skillId).toMatch(/^skill-[0-9a-f]{8}$/u)
    })

    it('keeps the stored content byte-identical when the declared name is already valid', async () => {
      const filePath = writeLocalSkill(localSkillBody)
      await handler('skills:inspect-local')({}, filePath)

      await expect(handler('skills:install-local')({}, filePath)).resolves.toMatchObject({
        success: true,
        skill: { name: 'local-prose' },
      })
      expect(fs.readFileSync(path.join(velaHome, 'skills', 'local-prose', 'SKILL.md'), 'utf8'))
        .toBe(localSkillBody)
    })
  })
})
