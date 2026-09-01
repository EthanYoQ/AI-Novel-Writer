import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({ handlers: new Map<string, IpcHandler>() }))

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)) },
}))
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
})
