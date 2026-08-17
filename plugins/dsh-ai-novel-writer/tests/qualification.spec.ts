/** Static qualification checks for the tarball/profile release runner. */
import { execFile } from 'node:child_process'
import { access, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { makeTestWorkspace } from './test-workspace.ts'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const runner = join(packageRoot, 'scripts', 'qualify-release.mjs')

describe('release qualification runner', () => {
  it('accepts the source package only when every shipped entry and dedicated Preset is present', async () => {
    await expect(execFileAsync(process.execPath, [runner, '--check-source'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).resolves.toMatchObject({ stdout: expect.stringContaining('source qualification passed') })
  })

  it('rejects a dedicated Preset that mounts a general shell tool', async () => {
    const root = await makeTestWorkspace('qualification-unsafe-preset-')
    const preset = join(root, 'agent.cordis.yml')
    await writeFile(preset, [
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '- id: shell',
      "  name: '@deepseek-ai/dsh-tool-pwsh'",
      '- id: novel-agent',
      "  name: '@ethanyoq/dsh-ai-novel-writer/agent'",
      '',
    ].join('\n'))

    await expect(execFileAsync(process.execPath, [runner, '--validate-preset', preset], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).rejects.toMatchObject({ stderr: expect.stringContaining('Preset plugin roster is not dedicated to novel writing') })
  })

  it('rejects an evidence root outside the repository cache before claiming ownership', async () => {
    const root = await makeTestWorkspace('qualification-outside-cache-')

    await expect(execFileAsync(process.execPath, [
      runner, '--harness-root', packageRoot, '--qualification-root', root,
    ], { cwd: packageRoot, encoding: 'utf8' }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Qualification path must be a child') })
    await expect(access(join(root, '.vibe-owner.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects qualification against a different clean Harness revision', async () => {
    await expect(execFileAsync(process.execPath, [
      runner, '--validate-harness-commit', '0000000000000000000000000000000000000000',
    ], { cwd: packageRoot, encoding: 'utf8' }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Qualification requires DeepSeek Harness commit') })
  })

  it('rejects a disposable profile that omits the pinned dsh-web-ui-all bundle', async () => {
    const root = await makeTestWorkspace('qualification-profile-manifest-')
    const manifest = join(root, 'package.json')
    await writeFile(manifest, `${JSON.stringify({
      dependencies: {
        '@ethanyoq/dsh-ai-novel-writer': 'file:C:/owned/plugin.tgz',
        '@linxin666/dsh-web-ui-all': '0.1.16',
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-web-app',
            '@ethanyoq/dsh-ai-novel-writer',
          ],
        },
      },
    }, null, 2)}\n`, 'utf8')

    await expect(execFileAsync(process.execPath, [
      runner, '--validate-profile', manifest, 'plugin.tgz',
    ], { cwd: packageRoot, encoding: 'utf8' }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Profile bundle is missing: @linxin666/dsh-web-ui-all') })
  })

  it('rejects a packed-profile request header that leaks a dsh-web-ui-all tool', async () => {
    const root = await makeTestWorkspace('qualification-request-log-')
    const log = join(root, 'model-requests.jsonl')
    const schemas = join(root, 'installed-tool-schemas.json')
    await writeFile(schemas, `${JSON.stringify([
      { name: 'novel_read', description: 'read', parameters: { type: 'object' } },
      { name: 'novel_apply_change', description: 'apply', parameters: { type: 'object' } },
    ])}\n`, 'utf8')
    await writeFile(log, `${JSON.stringify({
      type: 'model-request',
      request: {
        system: 'novel persona',
        tools: [
          { name: 'novel_read', description: 'read', parameters: { type: 'object' } },
          { name: 'novel_apply_change', description: 'apply', parameters: { type: 'object' } },
          { name: 'ssh_execute', description: 'ssh', parameters: { type: 'object' } },
        ],
      },
    })}\n`, 'utf8')

    await expect(execFileAsync(process.execPath, [runner, '--validate-model-log', log, schemas], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).rejects.toMatchObject({ stderr: expect.stringContaining('complete installed Preset schemas') })
  })

  it('rejects same-name model tools whose schemas differ from the installed Preset', async () => {
    const root = await makeTestWorkspace('qualification-truncated-schema-')
    const log = join(root, 'model-requests.jsonl')
    const schemas = join(root, 'installed-tool-schemas.json')
    const installedTools = [
      {
        name: 'novel_read',
        description: 'Read a bounded novel asset.',
        parameters: {
          type: 'object',
          properties: { kind: { enum: ['asset', 'query', 'working-set'] } },
          required: ['kind'],
        },
      },
      {
        name: 'novel_apply_change',
        description: 'Apply one approved novel change.',
        parameters: {
          type: 'object',
          properties: { kind: { enum: ['initialize', 'replace'] } },
          required: ['kind'],
        },
      },
    ]
    await writeFile(schemas, `${JSON.stringify(installedTools)}\n`, 'utf8')
    await writeFile(log, `${JSON.stringify({
      type: 'model-request',
      request: {
        system: 'novel persona',
        tools: installedTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: { type: 'object' },
        })),
      },
    })}\n`, 'utf8')

    await expect(execFileAsync(process.execPath, [runner, '--validate-model-log', log, schemas], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).rejects.toMatchObject({ stderr: expect.stringContaining('installed Preset schemas') })
  })

  it('keeps deterministic backend steps isolated between sessions with identical proposal text', async () => {
    const backend = join(packageRoot, 'scripts', 'qualification-web-backend.mjs').replaceAll('\\', '/')
    const prompt = '{"kind":"replace","targetKind":"story-blueprint"}\n\n这只是提案。'
    const probe = [
      `import { proposalFromMessages } from ${JSON.stringify(`file:///${backend}`)}`,
      `const prompt = ${JSON.stringify(prompt)}`,
      "const first = proposalFromMessages([{ id: 'session-a-message', content: [{ type: 'text', text: prompt }] }])",
      "const continuation = proposalFromMessages([{ id: 'session-a-message', content: [{ type: 'text', text: prompt }] }, { id: 'tool-result', content: [] }])",
      "const second = proposalFromMessages([{ id: 'session-b-message', content: [{ type: 'text', text: prompt }] }])",
      'process.stdout.write(JSON.stringify([first?.key, continuation?.key, second?.key]))',
    ].join(';')
    const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    const [first, continuation, second] = JSON.parse(result.stdout) as string[]
    expect(continuation).toBe(first)
    expect(second).not.toBe(first)
  })

  it('times out a real command only after its stubborn subprocess tree is terminated', async () => {
    const root = await makeTestWorkspace('qualification-command-timeout-')
    await expect(execFileAsync(process.execPath, [runner, '--probe-command-timeout', root], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 15_000,
    })).resolves.toMatchObject({ stdout: expect.stringContaining('command timeout cleanup passed') })
  }, 15_000)
})
