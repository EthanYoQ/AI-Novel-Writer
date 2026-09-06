import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  loadConfig: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  disconnectAll: vi.fn(),
  getAllTools: vi.fn((): unknown[] => []),
  getAllResources: vi.fn((): unknown[] => []),
  callTool: vi.fn(),
  getServersStatus: vi.fn((): unknown[] => []),
  getDefaultConfigPath: vi.fn(() => 'C:/isolated/.vela/mcp_config.json'),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../mcp-manager', () => ({ mcpManager: mocks }))

import { registerMCPHandlers } from '../mcp-ipc-bridge'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

beforeAll(() => registerMCPHandlers())

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadConfig.mockResolvedValue({
    status: 'loaded',
    servers: [{ id: 'safe-id', name: 'Safe server', transport: 'stdio' }],
  })
})

describe('MCP IPC trust boundary', () => {
  it('does not accept an arbitrary config path or expose trusted launch configuration', async () => {
    const result = await handler('mcp:load-config')({}, 'C:/attacker/config.json')

    expect(mocks.loadConfig).toHaveBeenCalledWith()
    expect(result).toEqual({
      success: true,
      status: 'loaded',
      servers: [{ id: 'safe-id', name: 'Safe server', transport: 'stdio' }],
    })
    expect(JSON.stringify(result)).not.toMatch(/command|args|env|url|SECRET_(?:COMMAND|ARGUMENT|ENV|URL)_MARKER/iu)
  })

  it('connects by a previously loaded server id and reports initialization failure', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('SECRET_INITIALIZE_ERROR_MARKER'))

    const result = await handler('mcp:connect')({}, 'safe-id')
    expect(result).toEqual({
      success: false,
      error: 'MCP 服务器连接失败',
    })
    expect(JSON.stringify(result)).not.toContain('SECRET_INITIALIZE_ERROR_MARKER')
    expect(mocks.connect).toHaveBeenCalledWith('safe-id')
  })

  it('makes malformed configuration visible while preserving missing as a distinct state', async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      status: 'error',
      servers: [],
      error: 'MCP 配置损坏，未加载任何服务器',
    })
    await expect(handler('mcp:load-config')({})).resolves.toEqual({
      success: false,
      status: 'error',
      servers: [],
      error: 'MCP 配置损坏，未加载任何服务器',
    })

    mocks.loadConfig.mockResolvedValueOnce({ status: 'missing', servers: [] })
    await expect(handler('mcp:load-config')({})).resolves.toEqual({
      success: true,
      status: 'missing',
      servers: [],
    })
  })
})
