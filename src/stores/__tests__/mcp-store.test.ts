import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  register: vi.fn(),
  unregisterBySource: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invoke: mocks.invoke },
}))

vi.mock('../../services/agent/tool-registry', () => ({
  toolRegistry: {
    register: mocks.register,
    unregisterBySource: mocks.unregisterBySource,
  },
}))

import { useMCPStore } from '../mcp-store'

beforeEach(() => {
  vi.clearAllMocks()
  useMCPStore.setState({
    servers: [],
    tools: [],
    resources: [],
    configPath: null,
    loading: false,
    error: null,
  })
})

describe('renderer MCP trust boundary', () => {
  it('initializes and connects using safe server ids only', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:get-config-path') return 'C:/isolated/.vela/mcp_config.json'
      if (channel === 'mcp:load-config') {
        return {
          success: true,
          status: 'loaded',
          servers: [{ id: 'safe-id', name: 'Safe server', transport: 'stdio' }],
        }
      }
      if (channel === 'mcp:connect') return { success: true }
      if (channel === 'mcp:get-servers-status') return []
      if (channel === 'mcp:list-tools' || channel === 'mcp:list-resources') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await useMCPStore.getState().init()

    expect(mocks.invoke).toHaveBeenCalledWith('mcp:connect', 'safe-id')
    expect(mocks.invoke.mock.calls.find(([channel]) => channel === 'mcp:connect')?.[1])
      .toBeTypeOf('string')
    expect(useMCPStore.getState()).toMatchObject({ loading: false, error: null })
  })

  it('shows corrupt configuration errors but treats missing configuration as empty', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:get-config-path') return 'C:/isolated/.vela/mcp_config.json'
      if (channel === 'mcp:load-config') {
        return { success: false, status: 'error', servers: [], error: 'MCP 配置损坏' }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await useMCPStore.getState().init()
    expect(useMCPStore.getState()).toMatchObject({ loading: false, error: 'MCP 配置损坏' })

    useMCPStore.setState({ error: null })
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:get-config-path') return 'C:/isolated/.vela/mcp_config.json'
      if (channel === 'mcp:load-config') {
        return { success: true, status: 'missing', servers: [] }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    await useMCPStore.getState().init()
    expect(useMCPStore.getState()).toMatchObject({ loading: false, error: null })
  })

  it('keeps the existing human-confirmation requirement for every registered MCP tool', () => {
    useMCPStore.setState({
      tools: [{
        name: 'write_remote',
        description: 'Writes remote state',
        inputSchema: { type: 'object' },
        serverId: 'safe-id',
      }],
    })

    useMCPStore.getState().registerMCPToolsToRegistry()

    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'mcp__safe-id__write_remote',
      requiresConfirmation: true,
      isReadOnly: false,
    }))
  })
})
