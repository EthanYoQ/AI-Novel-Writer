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

  it('times out a real command only after its stubborn subprocess tree is terminated', async () => {
    const root = await makeTestWorkspace('qualification-command-timeout-')
    await expect(execFileAsync(process.execPath, [runner, '--probe-command-timeout', root], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 15_000,
    })).resolves.toMatchObject({ stdout: expect.stringContaining('command timeout cleanup passed') })
  })
})
