/** Static qualification checks for the tarball/profile release runner. */
import { execFile, spawn } from 'node:child_process'
import { access, cp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { novelProposalArgsHash, openNovelStore } from '../src/novel-store.ts'
import { makeTestWorkspace } from './test-workspace.ts'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const runner = join(packageRoot, 'scripts', 'qualify-release.mjs')

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function supportsForcedWindowsTreeTermination(): Promise<boolean> {
  if (process.platform !== 'win32') return true
  const source = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)"
  const root = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] })
  if (root.stdout === null) throw new Error('Windows process-tree capability probe did not expose stdout')
  let pids: readonly number[] = []
  try {
    pids = await new Promise<readonly number[]>((resolve, reject) => {
      let buffer = ''
      root.stdout?.on('data', chunk => {
        buffer += String(chunk)
        try { resolve(JSON.parse(buffer) as readonly number[]) } catch {}
      })
      root.once('error', reject)
    })
    try {
      await execFileAsync('taskkill.exe', ['/pid', String(root.pid), '/t', '/f'], {
        encoding: 'utf8', timeout: 2_000, windowsHide: true,
      })
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
    return pids.every(pid => !processIsAlive(pid))
  } finally {
    for (const pid of pids) {
      if (!processIsAlive(pid)) continue
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    if (root.exitCode === null && root.signalCode === null) {
      try { root.kill('SIGKILL') } catch {}
    }
  }
}

describe('release qualification runner', () => {
  it('accepts the source package only when every shipped entry and dedicated Preset is present', async () => {
    await expect(execFileAsync(process.execPath, [runner, '--check-source'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).resolves.toMatchObject({ stdout: expect.stringContaining('source qualification passed') })
  })

  it('accepts the V2.2 proposal preset, which describes exactly the read and proposal tools', async () => {
    await expect(execFileAsync(process.execPath, [
      runner, '--validate-preset', join(packageRoot, 'presets', 'ai-novel-writer-v2', 'agent.cordis.yml'),
    ], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).resolves.toMatchObject({ stdout: expect.stringContaining('preset qualification passed') })
  })

  it('validates the installed V2 preset template rather than a legacy lifecycle', async () => {
    await expect(execFileAsync(process.execPath, [
      runner, '--validate-installed-preset', packageRoot,
    ], { cwd: packageRoot, encoding: 'utf8' })).resolves.toMatchObject({
      stdout: expect.stringContaining('"presetId":"ai-novel-writer-v2"'),
    })
  })

  it('keeps browser qualification on the installed V2 preset root without user preset shadowing', async () => {
    const source = await readFile(runner, 'utf8')
    const start = source.indexOf('async function writeQualificationOverlay(')
    const end = source.indexOf('async function writeDesignQa(', start)
    const overlay = source.slice(start, end)

    expect(overlay).toContain('includeUserRoot: false')
    expect(overlay).not.toContain('includeUserRoot: true')
  })

  it('documents the V2 installed keyless qualification snapshot and its native-model limit', async () => {
    const readme = await readFile(join(packageRoot, 'README.md'), 'utf8')
    const start = readme.indexOf('## Release qualification')
    const section = readme.slice(start)

    expect(section).toContain('novel_read')
    expect(section).toContain('novel_propose_change')
    expect(section).toContain('dsh-ai-novel-qualification-128')
    expect(section).toContain('A browser skipped result is not qualified')
    expect(section).toContain('gpt-5.6-terra manual qualification')
    expect(section).not.toContain('novel_apply_change')
    expect(section).not.toContain('story-blueprint')
    expect(section).not.toContain('dsh-ai-novel-qualification-113')
  })

  it('rejects a browser skipped result so a skipped browser journey cannot qualify', async () => {
    await expect(execFileAsync(process.execPath, [
      runner, '--validate-browser-result', JSON.stringify({ status: 'skipped', reason: 'missing-harness-root' }),
    ], { cwd: packageRoot, encoding: 'utf8' })).rejects.toMatchObject({
      stderr: expect.stringContaining('Browser qualification was skipped and is not qualified'),
    })
  })

  it('compares every required installed package artifact to the packed-content root after reinstall', async () => {
    const root = await makeTestWorkspace('qualification-installed-content-')
    const installedRoot = join(root, 'installed')
    await cp(packageRoot, installedRoot, {
      recursive: true,
      filter: source => !source.includes(`${sep}node_modules`),
    })

    await expect(execFileAsync(process.execPath, [
      runner, '--validate-installed-content', packageRoot, installedRoot,
    ], { cwd: packageRoot, encoding: 'utf8' })).resolves.toMatchObject({
      stdout: expect.stringContaining('installed content qualification passed'),
    })
    await writeFile(join(installedRoot, 'lib', 'index.js'), 'tampered installed entry\n', 'utf8')
    await expect(execFileAsync(process.execPath, [
      runner, '--validate-installed-content', packageRoot, installedRoot,
    ], { cwd: packageRoot, encoding: 'utf8' })).rejects.toMatchObject({
      stderr: expect.stringContaining('does not match packed tarball content'),
    })
  })

  it('rejects an installed schema that exposes the legacy authoritative mutation tool', async () => {
    const root = await makeTestWorkspace('qualification-legacy-tool-schema-')
    const log = join(root, 'model-requests.jsonl')
    const schemas = join(root, 'installed-tool-schemas.json')
    const legacyTools = [
      { name: 'novel_read', description: 'read', parameters: { type: 'object' } },
      { name: 'novel_apply_change', description: 'apply', parameters: { type: 'object' } },
    ]
    await writeFile(schemas, `${JSON.stringify(legacyTools)}\n`, 'utf8')
    await writeFile(log, `${JSON.stringify({
      type: 'model-request', request: { system: 'novel persona', tools: legacyTools },
    })}\n`, 'utf8')

    await expect(execFileAsync(process.execPath, [runner, '--validate-model-log', log, schemas], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).rejects.toMatchObject({ stderr: expect.stringContaining('novel_propose_change') })
  })

  it('requires the keyless model log to contain one exact read then one fixed V2 proposal', async () => {
    const root = await makeTestWorkspace('qualification-tool-call-log-')
    const log = join(root, 'model-requests.jsonl')
    const schemas = join(root, 'installed-tool-schemas.json')
    const tools = [
      { name: 'novel_read', description: 'read', parameters: { type: 'object' } },
      { name: 'novel_propose_change', description: 'propose', parameters: { type: 'object' } },
    ]
    const proposal = JSON.parse((await execFileAsync(process.execPath, [runner, '--qualification-proposal'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).stdout)
    const rows = [
      { type: 'model-request', request: { system: 'V2 persona', tools } },
      { type: 'model-tool-call', name: 'novel_read', arguments: { kind: 'state' } },
      { type: 'model-tool-call', name: 'novel_propose_change', arguments: proposal },
    ]
    await writeFile(schemas, `${JSON.stringify(tools)}\n`, 'utf8')
    await writeFile(log, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    await expect(execFileAsync(process.execPath, [runner, '--validate-model-log', log, schemas], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).resolves.toMatchObject({ stdout: expect.stringContaining('"toolCalls":2') })

    await writeFile(log, `${[...rows, {
      type: 'model-tool-call', name: 'novel_read', arguments: { kind: 'state' },
    }].map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    await expect(execFileAsync(process.execPath, [runner, '--validate-model-log', log, schemas], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).rejects.toMatchObject({ stderr: expect.stringContaining('exactly one novel_read followed by one novel_propose_change') })
  })

  it('records only V2 read and proposal calls from the keyless qualification backend', async () => {
    const root = await makeTestWorkspace('qualification-v2-keyless-tools-')
    const log = join(root, 'model-requests.jsonl')
    const backend = join(packageRoot, 'scripts', 'qualification-web-backend.mjs').replaceAll('\\', '/')
    const proposal = {
      changes: [{
        kind: 'artifact/draft', artifactId: 'qualification-chapter-1-draft', chapter: 1,
        content: '潮水退去，信件显露。', summary: '创建第一章草稿。',
      }],
    }
    const tools = [
      { name: 'novel_read', description: 'read', parameters: { type: 'object' } },
      { name: 'novel_propose_change', description: 'propose', parameters: { type: 'object' } },
    ]
    const request = {
      provider: 'novel-qualification', model: 'keyless', system: 'V2 persona', tools,
      messages: [{ id: 'v2-proposal-message', content: [{ type: 'text', text: `${JSON.stringify(proposal)}\n\n这只是提案。` }] }],
    }
    const probe = [
      `import { apply } from ${JSON.stringify(`file:///${backend}`)}`,
      'let adapter',
      "apply({ effect: effect => effect(), llm: { registerAdapter: (_providers, value) => { adapter = value } } })",
      `const request = ${JSON.stringify(request)}`,
      'const collect = async () => { const chunks = []; for await (const chunk of adapter.stream(request)) chunks.push(chunk); return chunks }',
      'const first = await collect(); const second = await collect()',
      'process.stdout.write(JSON.stringify({ first, second }))',
    ].join(';')
    const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: { ...process.env, DSH_NOVEL_QUALIFICATION_LOG: log },
    })
    const payload = JSON.parse(result.stdout) as { first: Array<{ name?: string }>; second: Array<{ name?: string }> }
    expect(payload.first.find(chunk => chunk.name !== undefined)?.name).toBe('novel_read')
    expect(payload.second.find(chunk => chunk.name !== undefined)?.name).toBe('novel_propose_change')
    const logs = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line) as { type: string; name?: string })
    expect(logs.filter(row => row.type === 'model-tool-call').map(row => row.name)).toEqual([
      'novel_read', 'novel_propose_change',
    ])
  })

  it('reads V2 schema 4, a partial proposal, and a user-selected final without V1 manifest assumptions', async () => {
    const root = await makeTestWorkspace('qualification-v2-readback-')
    const workspaceId = WorkspaceId('qualification-v2-workspace')
    const signal = new AbortController().signal
    const store = await openNovelStore(root, workspaceId)
    try {
      await store.initialize({
        workspaceId,
        title: '潮汐来信', language: 'zh-CN', genre: '奇幻悬疑', plannedChapters: 1,
        targetWordsPerChapter: 2_000, creativeStrategy: 'consistency-first', structureMode: 'three-act',
        narrativePov: 'third-limited', globalGuidance: '保持冷峻而温柔的语气。',
      }, signal)
      const proposalResult = await execFileAsync(process.execPath, [runner, '--qualification-proposal'], {
        cwd: packageRoot,
        encoding: 'utf8',
      })
      const payload = JSON.parse(proposalResult.stdout) as { changes: Array<{ kind?: string; aggregate?: { kind?: string; chapter?: number } }> }
      expect(Object.keys(payload)).toEqual(['changes'])
      expect(payload.changes).toHaveLength(5)
      expect(payload.changes.map(change => change.kind ?? change.aggregate?.kind)).toEqual([
        'chapter', 'chapter', 'artifact/draft', 'chapter/select-final', 'artifact/review',
      ])
      expect(payload.changes[0]).toMatchObject({ aggregate: { kind: 'chapter', chapter: 1 }, baseAggregateRevision: 0, baseGlobalRevision: 0 })
      expect(payload.changes[1]).toMatchObject({ aggregate: { kind: 'chapter', chapter: 2 }, baseAggregateRevision: 0, baseGlobalRevision: 1 })
      expect(payload.changes[2]).toMatchObject({ kind: 'artifact/draft', chapter: 1, artifactId: 'qualification-chapter-1-draft' })
      expect(payload.changes[3]).toMatchObject({ kind: 'chapter/select-final', chapter: 1, artifactId: 'qualification-chapter-1-draft' })
      expect(payload.changes[4]).toMatchObject({ kind: 'artifact/review', chapter: 1, parentArtifactId: 'qualification-missing-draft' })

      const proposal = await store.submitProposal({
        sessionId: 'qualification-session', callId: 'qualification-partial',
        argsHash: novelProposalArgsHash(payload), payload,
      }, signal)
      const applied = await store.applyProposal(proposal.proposal.proposalId, signal)
      expect(applied.proposal.status).toBe('partial')
      expect(applied.proposal.items.map(item => ({ status: item.status, failure: item.failure }))).toEqual([
        { status: 'applied', failure: undefined },
        { status: 'applied', failure: undefined },
        { status: 'applied', failure: undefined },
        { status: 'applied', failure: undefined },
        { status: 'failed', failure: 'INVALID_CONTENT' },
      ])
      await expect(store.readChapterContext(2, signal)).resolves.toMatchObject({
        chapter: 2,
        previousFinal: {
          chapter: 1, artifactId: 'qualification-chapter-1-draft', content: '潮水退去，信件显露。', summary: '用户选择第一章草稿为定稿。',
        },
      })
    } finally {
      await store.dispose()
    }

    const result = await execFileAsync(process.execPath, [
      runner, '--readback', join(packageRoot, 'lib', 'index.js'), root,
    ], { cwd: packageRoot, encoding: 'utf8' })
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 4,
      proposals: expect.arrayContaining([
        expect.objectContaining({ status: 'partial', itemCount: 5 }),
      ]),
      artifacts: [expect.objectContaining({ artifactId: 'qualification-chapter-1-draft', kind: 'draft' })],
      chapterFinals: [expect.objectContaining({ chapter: 1, artifactId: 'qualification-chapter-1-draft' })],
    })
  })

  it('rejects a readback whose partial proposal does not retain the fixed five-item V2 evidence', async () => {
    const root = await makeTestWorkspace('qualification-incomplete-partial-')
    const workspaceId = WorkspaceId('qualification-v2-workspace')
    const signal = new AbortController().signal
    const store = await openNovelStore(root, workspaceId)
    try {
      await store.initialize({
        workspaceId,
        title: 'Qualification', language: 'en', genre: 'test', plannedChapters: 2,
        targetWordsPerChapter: 1_000, creativeStrategy: 'auto', structureMode: 'three-act',
        narrativePov: 'third-limited', globalGuidance: 'Test only.',
      }, signal)
      const fixed = JSON.parse((await execFileAsync(process.execPath, [runner, '--qualification-proposal'], {
        cwd: packageRoot,
        encoding: 'utf8',
      })).stdout) as { changes: unknown[] }
      const payload = { changes: fixed.changes.filter((_change, index) => index !== 1) }
      const proposal = await store.submitProposal({
        sessionId: 'qualification-session', callId: 'incomplete-partial',
        argsHash: novelProposalArgsHash(payload), payload,
      }, signal)
      await store.applyProposal(proposal.proposal.proposalId, signal)
    } finally {
      await store.dispose()
    }

    await expect(execFileAsync(process.execPath, [
      runner, '--readback', join(packageRoot, 'lib', 'index.js'), root,
    ], { cwd: packageRoot, encoding: 'utf8' })).rejects.toMatchObject({
      stderr: expect.stringContaining('fixed five-item V2 proposal lifecycle'),
    })
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

  it('does not start an actual qualification without an explicit Harness root', async () => {
    const environment = { ...process.env }
    delete environment.DSH_HARNESS_ROOT
    await expect(execFileAsync(process.execPath, [runner], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: environment,
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('Qualification requires an absolute --harness-root or DSH_HARNESS_ROOT'),
    })
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
      { name: 'novel_propose_change', description: 'propose', parameters: { type: 'object' } },
    ])}\n`, 'utf8')
    await writeFile(log, `${JSON.stringify({
      type: 'model-request',
      request: {
        system: 'novel persona',
        tools: [
          { name: 'novel_read', description: 'read', parameters: { type: 'object' } },
          { name: 'novel_propose_change', description: 'propose', parameters: { type: 'object' } },
          { name: 'ssh_execute', description: 'ssh', parameters: { type: 'object' } },
        ],
      },
    })}\n`, 'utf8')

    await expect(execFileAsync(process.execPath, [runner, '--validate-model-log', log, schemas], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).rejects.toMatchObject({ stderr: expect.stringContaining('exactly novel_read and novel_propose_change') })
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
        name: 'novel_propose_change',
        description: 'Persist one non-authoritative proposal bundle.',
        parameters: {
          type: 'object',
          properties: { changes: { type: 'array' } },
          required: ['changes'],
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

  it('times out a real command only after its stubborn subprocess tree is terminated', async (context) => {
    if (!(await supportsForcedWindowsTreeTermination())) {
      context.skip('Windows cannot force-terminate this test process tree in the current execution environment')
    }
    const root = await makeTestWorkspace('qualification-command-timeout-')
    await expect(execFileAsync(process.execPath, [runner, '--probe-command-timeout', root], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 15_000,
    })).resolves.toMatchObject({ stdout: expect.stringContaining('command timeout cleanup passed') })
  }, 15_000)
})
