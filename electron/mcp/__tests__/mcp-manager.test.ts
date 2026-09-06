import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'C:/REAL-HOME-MUST-NOT-BE-READ') } }))

type Manager = typeof import('../mcp-manager')['mcpManager']

let velaHome = ''
let mcpManager: Manager

function createMcpProcess(options: { initializeError?: string; failToStart?: boolean; neverRespond?: boolean } = {}) {
  const processEmitter = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdin = {
    write: vi.fn((raw: string) => {
      const request = JSON.parse(raw) as { id?: number; method: string }
      if (request.id === undefined) return true
      if (options.failToStart) {
        queueMicrotask(() => processEmitter.emit('error', new Error('SECRET_CHILD_ERROR_MARKER')))
        return true
      }
      if (options.neverRespond) return true

      const payload = request.method === 'initialize' && options.initializeError
        ? { error: { message: options.initializeError } }
        : {
            result: request.method === 'tools/list'
              ? { tools: [] }
              : request.method === 'resources/list'
                ? { resources: [] }
                : {},
          }
      queueMicrotask(() => {
        stdout.emit('data', Buffer.from(`${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          ...payload,
        })}\n`))
      })
      return true
    }),
  }

  return Object.assign(processEmitter, {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
  })
}

function writeConfig(value: unknown): void {
  fs.writeFileSync(
    path.join(velaHome, 'mcp_config.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  )
}

beforeEach(async () => {
  vi.resetModules()
  spawnMock.mockReset()
  velaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-mcp-'))
  process.env.AI_NOVEL_VELA_HOME = velaHome
  mcpManager = (await import('../mcp-manager')).mcpManager
})

afterEach(async () => {
  vi.useRealTimers()
  await mcpManager.disconnectAll()
  delete process.env.AI_NOVEL_VELA_HOME
  fs.rmSync(velaHome, { recursive: true, force: true })
})

describe('MCP trusted configuration boundary', () => {
  it('uses the isolated VELA_HOME and distinguishes a missing config', async () => {
    expect(mcpManager.getDefaultConfigPath()).toBe(path.join(velaHome, 'mcp_config.json'))
    await expect(mcpManager.loadConfig()).resolves.toEqual({ status: 'missing', servers: [] })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('revokes previously trusted ids when a reload is missing or corrupt', async () => {
    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'loaded' })
    fs.unlinkSync(path.join(velaHome, 'mcp_config.json'))

    await expect(mcpManager.loadConfig()).resolves.toEqual({ status: 'missing', servers: [] })
    await expect(mcpManager.connect('old_server')).rejects.toThrow(/未配置/u)

    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'loaded' })
    writeConfig('{BROKEN_MCP_CONFIG')

    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'error', servers: [] })
    await expect(mcpManager.connect('old_server')).rejects.toThrow(/未配置/u)
  })

  it('disconnects an active server when its configuration becomes missing', async () => {
    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    const process = createMcpProcess()
    spawnMock.mockReturnValue(process)
    await mcpManager.loadConfig()
    await mcpManager.connect('old_server')
    fs.unlinkSync(path.join(velaHome, 'mcp_config.json'))

    await expect(mcpManager.loadConfig()).resolves.toEqual({ status: 'missing', servers: [] })

    expect(process.kill).toHaveBeenCalledOnce()
    expect(mcpManager.getServersStatus()).toEqual([])
  })

  it('disconnects an active server when its configuration becomes corrupt', async () => {
    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    const process = createMcpProcess()
    spawnMock.mockReturnValue(process)
    await mcpManager.loadConfig()
    await mcpManager.connect('old_server')
    writeConfig('{BROKEN_MCP_CONFIG')

    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'error', servers: [] })

    expect(process.kill).toHaveBeenCalledOnce()
    expect(mcpManager.getServersStatus()).toEqual([])
  })

  it('keeps unchanged connections and disconnects deleted or changed servers on reload', async () => {
    writeConfig({
      mcpServers: {
        unchanged: { command: 'node', args: ['same.js'] },
        changed: { command: 'node', args: ['old.js'] },
        deleted: { command: 'node', args: ['gone.js'] },
      },
    })
    const unchangedProcess = createMcpProcess()
    const changedProcess = createMcpProcess()
    const deletedProcess = createMcpProcess()
    spawnMock
      .mockReturnValueOnce(unchangedProcess)
      .mockReturnValueOnce(changedProcess)
      .mockReturnValueOnce(deletedProcess)
    await mcpManager.loadConfig()
    await mcpManager.connect('unchanged')
    await mcpManager.connect('changed')
    await mcpManager.connect('deleted')

    writeConfig({
      mcpServers: {
        unchanged: { command: 'node', args: ['same.js'] },
        changed: { command: 'node', args: ['new.js'] },
        added: { command: 'node', args: ['new-server.js'] },
      },
    })
    await mcpManager.loadConfig()

    expect(unchangedProcess.kill).not.toHaveBeenCalled()
    expect(changedProcess.kill).toHaveBeenCalledOnce()
    expect(deletedProcess.kill).toHaveBeenCalledOnce()
    expect(mcpManager.getServersStatus().map(server => server.id)).toEqual(['unchanged'])
  })

  it('reports a malformed config instead of treating it as missing', async () => {
    writeConfig({
      mcpServers: {
        appears_before_damage: { command: 'node' },
        damaged: { args: 'not-an-array' },
      },
    })
    await expect(mcpManager.loadConfig()).resolves.toEqual({
      status: 'error',
      servers: [],
      error: expect.stringMatching(/MCP.*配置.*损坏/u),
    })
    await expect(mcpManager.connect('appears_before_damage')).rejects.toThrow(/未配置/u)
  })

  it('reports invalid JSON as corrupt configuration', async () => {
    writeConfig('{BROKEN_MCP_CONFIG')
    await expect(mcpManager.loadConfig()).resolves.toEqual({
      status: 'error',
      servers: [],
      error: expect.stringMatching(/MCP.*配置.*损坏/u),
    })
  })

  it.each([
    { serverConfig: {}, caseName: 'neither transport' },
    { serverConfig: { command: 'node', url: 'https://example.invalid/sse' }, caseName: 'ambiguous transport' },
    { serverConfig: { command: '   ' }, caseName: 'blank command' },
    { serverConfig: { url: '   ' }, caseName: 'blank URL' },
  ])('rejects $caseName instead of loading an unusable server', async ({ serverConfig }) => {
    writeConfig({ mcpServers: { invalid: serverConfig } })
    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'error', servers: [] })
    await expect(mcpManager.connect('invalid')).rejects.toThrow(/未配置/u)
  })

  it('keeps command arguments, environment, and credential URLs in the main process', async () => {
    writeConfig({
      mcpServers: {
        secret_stdio_server: {
          command: 'SECRET_COMMAND_MARKER',
          args: ['SECRET_ARGUMENT_MARKER'],
          env: { API_KEY: 'SECRET_ENV_MARKER' },
        },
        secret_sse_server: {
          url: 'https://user:SECRET_URL_MARKER@example.invalid/sse',
        },
      },
    })

    const result = await mcpManager.loadConfig()

    expect(result).toEqual({
      status: 'loaded',
      servers: [
        { id: 'secret_stdio_server', name: 'secret_stdio_server', transport: 'stdio' },
        { id: 'secret_sse_server', name: 'secret_sse_server', transport: 'sse' },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/SECRET_(?:COMMAND|ARGUMENT|ENV|URL)_MARKER/u)
  })

  it('rejects an id that was not loaded from the trusted config', async () => {
    await expect(mcpManager.connect('unconfigured')).rejects.toThrow(/未配置/u)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('hides the child window and connects only a loaded stdio server', async () => {
    writeConfig({
      mcpServers: {
        hidden_window_test: {
          command: 'node',
          args: ['server.js'],
          env: { MCP_TEST: '1' },
        },
      },
    })
    spawnMock.mockReturnValue(createMcpProcess())
    await mcpManager.loadConfig()

    await mcpManager.connect('hidden_window_test')

    expect(spawnMock).toHaveBeenCalledWith('node', ['server.js'], {
      env: expect.objectContaining({ MCP_TEST: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  })

  it('rejects when MCP session initialization fails and preserves an error status', async () => {
    writeConfig({ mcpServers: { broken: { command: 'node' } } })
    spawnMock.mockReturnValue(createMcpProcess({ initializeError: 'SECRET_INITIALIZE_ERROR_MARKER' }))
    await mcpManager.loadConfig()

    await expect(mcpManager.connect('broken')).rejects.toThrow(/MCP.*连接失败/u)
    expect(mcpManager.getServersStatus()).toEqual([
      expect.objectContaining({ id: 'broken', status: 'error', error: expect.stringMatching(/MCP.*连接失败/u) }),
    ])
    expect(JSON.stringify(mcpManager.getServersStatus())).not.toContain('SECRET_INITIALIZE_ERROR_MARKER')
  })

  it('settles once with a safe error when the child process fails to start', async () => {
    writeConfig({ mcpServers: { broken: { command: 'node' } } })
    spawnMock.mockReturnValue(createMcpProcess({ failToStart: true }))
    await mcpManager.loadConfig()

    await expect(mcpManager.connect('broken')).rejects.toThrow(/MCP.*连接失败/u)
    expect(mcpManager.getServersStatus()).toEqual([
      expect.objectContaining({ id: 'broken', status: 'error', error: 'MCP 服务器连接失败' }),
    ])
    expect(JSON.stringify(mcpManager.getServersStatus())).not.toContain('SECRET_CHILD_ERROR_MARKER')
  })

  it('times out initialization without leaving the connection pending', async () => {
    vi.useFakeTimers()
    writeConfig({ mcpServers: { silent: { command: 'node' } } })
    spawnMock.mockReturnValue(createMcpProcess({ neverRespond: true }))
    await mcpManager.loadConfig()

    const rejection = expect(mcpManager.connect('silent')).rejects.toThrow(/MCP.*连接失败/u)
    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
    expect(mcpManager.getServersStatus()).toEqual([
      expect.objectContaining({ id: 'silent', status: 'error' }),
    ])
  })
})
