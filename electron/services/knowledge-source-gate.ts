import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

const held = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>()
const tails = new Map<string, Promise<void>>()
const normalized = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)

export function assertKnowledgeSourceIdle(projectStorageRoot: string): void {
  const key = normalized(projectStorageRoot)
  if (tails.has(key) && !held.getStore()?.get(key)?.active) throw new Error('GENERATION_KNOWLEDGE_BUSY')
}

/** Serializes canonical KB changes with a short source verification/formal-write boundary. */
export async function withKnowledgeSourceGate<T>(projectStorageRoot: string, operation: () => T | Promise<T>): Promise<T> {
  const key = normalized(projectStorageRoot)
  if (held.getStore()?.get(key)?.active) return operation()
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>(resolve => { release = resolve })
  tails.set(key, tail)
  await previous
  const token = { active: true }
  try {
    return await held.run(new Map([...(held.getStore() ?? []), [key, token]]), operation)
  } finally {
    // Detached provider work can inherit this async context, but cannot retain a released lock.
    token.active = false
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}
