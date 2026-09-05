import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'C:/Users/Test') } }))

import { mcpManager } from '../mcp-manager'

function createMcpProcess() {
  const processEmitter = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdin = {
    write: vi.fn((raw: string) => {
      const request = JSON.parse(raw) as { id?: number; method: string }
      if (request.id === undefined) return true

      const result = request.method === 'tools/list'
        ? { tools: [] }
        : request.method === 'resources/list'
          ? { resources: [] }
          : {}
      queueMicrotask(() => {
        stdout.emit('data', Buffer.from(`${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result,
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

describe('MCP stdio process startup', () => {
  const serverId = 'hidden-window-test'

  afterEach(async () => {
    await mcpManager.disconnect(serverId)
    vi.clearAllMocks()
  })

  it('hides the child-process window on Windows-compatible stdio launches', async () => {
    spawnMock.mockReturnValue(createMcpProcess())

    await mcpManager.connect({
      id: serverId,
      name: 'Hidden window test',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { MCP_TEST: '1' },
    })

    expect(spawnMock).toHaveBeenCalledWith('node', ['server.js'], {
      env: expect.objectContaining({ MCP_TEST: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  })
})
