import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import * as yaml from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function yamlList(path: string): Promise<unknown[]> {
  const value = yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(value)) throw new TypeError(`${path} must contain a YAML list`)
  return value
}

describe('installable AI novel bundle', () => {
  it('keeps an independent private MIT package face', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    expect(manifest.private).toBe(true)
    expect(manifest.license).toBe('MIT')
    expect(manifest.packageManager).toBe('pnpm@11.11.0')
    for (const packagedFile of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      await expect(readFile(join(root, packagedFile), 'utf8')).resolves.toContain('MIT')
    }
  })

  it('loads its declared patch through the real Cordis Loader', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string; inject?: string[] } }
    }
    expect(manifest.dsh).toMatchObject({
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: [
          '@deepseek-ai/dsh-client-runtime',
          '@deepseek-ai/dsh-client-connection',
          '@deepseek-ai/dsh-client-ui-layout',
          '@deepseek-ai/dsh-client-ui-settings-plugins',
          '@deepseek-ai/dsh-client-ui-sidebar',
        ],
      },
    })
    const patches = await yamlList(join(root, manifest.dsh!.bundle!.patch!))
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    const handle = vi.fn(() => async () => {})
    ctx.provide('connection' as never, { rpc: { handle } } as never)
    ctx.provide('workspaceRegistry' as never, { get: () => undefined } as never)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    try {
      await ctx.loader.create({
        name: 'cordis:include',
        config: {
          path: pathToFileURL(join(root, 'tests', 'fixtures', 'empty.cordis.yml')).href,
          patches,
        },
      })
      await ctx.loader.await()
      const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'ai-novel-writer')
      expect(entry?.options.name).toBe('@ethanyoq/dsh-ai-novel-writer')
      expect(entry?.fiber).toBeDefined()
      expect(handle).toHaveBeenCalledWith('/ai-novel', expect.any(Function), { authority: 'loopback' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('is discovered by the Harness preset registry and mounts only the novel composition', async () => {
    const presetRoot = join(root, 'presets', 'ai-novel-writer')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(AgentPresets, {
      default: 'ai-novel-writer',
      roots: [{ path: join(root, 'presets'), trust: 'system' }],
      includeUserRoot: false,
    })

    const preset = (await ctx.agentPresets.list()).find(candidate => candidate.id === 'ai-novel-writer')
    expect(preset).toMatchObject({ name: 'AI 小说作家', trust: 'system' })
    expect(preset?.broken).toBeUndefined()
    expect(preset?.path).toBe(join(presetRoot, 'agent.cordis.yml'))

    const rows = await yamlList(join(presetRoot, 'agent.cordis.yml')) as Array<{
      id?: string
      name?: string
      config?: { text?: string }
    }>
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['persona', '@deepseek-ai/dsh-persona'],
      ['agent-instructions', '@deepseek-ai/dsh-agent-instructions'],
      ['novel-agent', '@ethanyoq/dsh-ai-novel-writer/agent'],
    ])
    const metadata = yaml.load(await readFile(join(presetRoot, 'preset.yml'), 'utf8'))
    expect(metadata).toMatchObject({ name: 'AI 小说作家' })
    expect(JSON.stringify(rows)).not.toMatch(/bash|shell|tool-fs|str-replace|code-mode/i)
    const persona = rows.find(row => row.id === 'persona')?.config?.text ?? ''
    expect(persona).toContain('auto：')
    expect(persona).toContain('fluent-drafting：')
    expect(persona).toContain('consistency-first：')
    expect(persona).toContain('deep-planning：')
    expect(persona).not.toMatch(/reasoningEffort|reasoning[_ -]?effort/i)
    const readme = await readFile(join(root, 'README.md'), 'utf8')
    const documentedPersona = /##### Stable novel persona\r?\n\r?\n```markdown\r?\n([\s\S]*?)\r?\n```/.exec(readme)?.[1]
    expect(documentedPersona?.replaceAll('\r\n', '\n')).toBe(persona)
    await ctx.fiber.dispose()
  })
})
