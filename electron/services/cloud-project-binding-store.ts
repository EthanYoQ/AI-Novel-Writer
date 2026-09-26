import path from 'node:path'

import { tryReadJsonFile, writeJsonFile } from '../utils/config-utils'
import { getGlobalDataRoot } from './app-data-locator'

export const CLOUD_BACKUP_BINDINGS_FILE = 'cloud-backup-bindings.json'

export type CloudProjectBindingMode = 'unconfigured' | 'writable' | 'origin-readonly'

export interface CloudProjectBinding {
  localProjectId: string
  cloudBookId: string
  localEndpointAccountId: string
  lastSelectedParentGenerationIds: string[]
  mode: CloudProjectBindingMode
  revision: number
}

export interface SaveCloudProjectBindingInput {
  localProjectId: string
  cloudBookId: string
  localEndpointAccountId: string
  lastSelectedParentGenerationIds: readonly string[]
}

export interface SaveWritableCloudProjectBindingInput extends SaveCloudProjectBindingInput {
  expectedRevision: number | null
}

interface CloudProjectBindingDocument {
  version: 1
  bindings: CloudProjectBinding[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/u
const MODES = new Set<CloudProjectBindingMode>(['unconfigured', 'writable', 'origin-readonly'])
const MAX_BINDINGS = 10_000
const MAX_PARENTS = 256

function fail(code: 'CLOUD_BINDING_DOCUMENT_INVALID' | 'CLOUD_BINDING_INPUT_INVALID' | 'CLOUD_BINDING_REVISION_CONFLICT'): never {
  throw new Error(code)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function validSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function parseParents(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARENTS || value.some(parent => !validSafeId(parent))) return null
  const parents = value as string[]
  return new Set(parents).size === parents.length ? [...parents] : null
}

function parseBinding(value: unknown): CloudProjectBinding | null {
  const source = record(value)
  if (!source || !exactKeys(source, [
    'localProjectId', 'cloudBookId', 'localEndpointAccountId',
    'lastSelectedParentGenerationIds', 'mode', 'revision',
  ])) return null
  const parents = parseParents(source.lastSelectedParentGenerationIds)
  if (!UUID.test(String(source.localProjectId)) || !validSafeId(source.cloudBookId)
    || !validSafeId(source.localEndpointAccountId) || !parents
    || typeof source.mode !== 'string' || !MODES.has(source.mode as CloudProjectBindingMode)
    || !Number.isSafeInteger(source.revision) || Number(source.revision) < 1) return null
  return {
    localProjectId: source.localProjectId as string,
    cloudBookId: source.cloudBookId,
    localEndpointAccountId: source.localEndpointAccountId,
    lastSelectedParentGenerationIds: parents,
    mode: source.mode as CloudProjectBindingMode,
    revision: source.revision as number,
  }
}

function parseDocument(value: unknown): CloudProjectBindingDocument {
  const source = record(value)
  if (!source || !exactKeys(source, ['version', 'bindings']) || source.version !== 1
    || !Array.isArray(source.bindings) || source.bindings.length > MAX_BINDINGS) {
    return fail('CLOUD_BINDING_DOCUMENT_INVALID')
  }
  const bindings = source.bindings.map(parseBinding)
  if (bindings.some(binding => !binding)) fail('CLOUD_BINDING_DOCUMENT_INVALID')
  const parsed = bindings as CloudProjectBinding[]
  if (new Set(parsed.map(binding => binding.localProjectId)).size !== parsed.length) {
    fail('CLOUD_BINDING_DOCUMENT_INVALID')
  }
  return { version: 1, bindings: parsed }
}

function normalizeInput(input: SaveCloudProjectBindingInput): Omit<CloudProjectBinding, 'mode' | 'revision'> {
  if (!UUID.test(input.localProjectId) || !validSafeId(input.cloudBookId)
    || !validSafeId(input.localEndpointAccountId) || !Array.isArray(input.lastSelectedParentGenerationIds)
    || input.lastSelectedParentGenerationIds.length > MAX_PARENTS
    || input.lastSelectedParentGenerationIds.some(parent => !validSafeId(parent))) {
    return fail('CLOUD_BINDING_INPUT_INVALID')
  }
  return {
    localProjectId: input.localProjectId,
    cloudBookId: input.cloudBookId,
    localEndpointAccountId: input.localEndpointAccountId,
    lastSelectedParentGenerationIds: [...new Set(input.lastSelectedParentGenerationIds)],
  }
}

function clone(binding: CloudProjectBinding): CloudProjectBinding {
  return { ...binding, lastSelectedParentGenerationIds: [...binding.lastSelectedParentGenerationIds] }
}

function nextRevision(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) fail('CLOUD_BINDING_REVISION_CONFLICT')
  return current + 1
}

export class CloudProjectBindingStore {
  private readonly filePath: string

  constructor(rootPath = getGlobalDataRoot()) {
    this.filePath = path.join(path.resolve(rootPath), CLOUD_BACKUP_BINDINGS_FILE)
  }

  get(localProjectId: string): CloudProjectBinding | null {
    if (!UUID.test(localProjectId)) fail('CLOUD_BINDING_INPUT_INVALID')
    const binding = this.read().bindings.find(candidate => candidate.localProjectId === localProjectId)
    return binding ? clone(binding) : null
  }

  list(): CloudProjectBinding[] {
    return this.read().bindings.map(clone)
  }

  saveWritable(input: SaveWritableCloudProjectBindingInput): CloudProjectBinding {
    const normalized = normalizeInput(input)
    if (input.expectedRevision !== null
      && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
      fail('CLOUD_BINDING_INPUT_INVALID')
    }
    const document = this.read()
    const index = document.bindings.findIndex(binding => binding.localProjectId === normalized.localProjectId)
    const current = document.bindings[index]
    if (current ? input.expectedRevision !== current.revision : input.expectedRevision !== null) {
      fail('CLOUD_BINDING_REVISION_CONFLICT')
    }
    const saved: CloudProjectBinding = {
      ...normalized,
      mode: 'writable',
      revision: current ? nextRevision(current.revision) : 1,
    }
    if (index === -1) document.bindings.push(saved)
    else document.bindings[index] = saved
    this.write(document)
    return clone(saved)
  }

  saveOriginReadonly(input: SaveCloudProjectBindingInput): CloudProjectBinding {
    const normalized = normalizeInput(input)
    const document = this.read()
    const current = document.bindings.find(binding => binding.localProjectId === normalized.localProjectId)
    if (current) {
      if (current.mode === 'origin-readonly'
        && current.cloudBookId === normalized.cloudBookId
        && current.localEndpointAccountId === normalized.localEndpointAccountId
        && current.lastSelectedParentGenerationIds.length === normalized.lastSelectedParentGenerationIds.length
        && current.lastSelectedParentGenerationIds.every((parent, index) => parent === normalized.lastSelectedParentGenerationIds[index])) {
        return clone(current)
      }
      fail('CLOUD_BINDING_REVISION_CONFLICT')
    }
    const saved: CloudProjectBinding = { ...normalized, mode: 'origin-readonly', revision: 1 }
    document.bindings.push(saved)
    this.write(document)
    return clone(saved)
  }

  markAccountUnconfigured(localEndpointAccountId: string): number {
    if (!validSafeId(localEndpointAccountId)) fail('CLOUD_BINDING_INPUT_INVALID')
    const document = this.read()
    let changed = 0
    document.bindings = document.bindings.map(binding => {
      if (binding.localEndpointAccountId !== localEndpointAccountId || binding.mode === 'unconfigured') return binding
      changed += 1
      return { ...binding, mode: 'unconfigured', revision: nextRevision(binding.revision) }
    })
    if (changed > 0) this.write(document)
    return changed
  }

  removeDeletedProject(localProjectId: string): boolean {
    if (!UUID.test(localProjectId)) fail('CLOUD_BINDING_INPUT_INVALID')
    const document = this.read()
    const bindings = document.bindings.filter(binding => binding.localProjectId !== localProjectId)
    if (bindings.length === document.bindings.length) return false
    this.write({ version: 1, bindings })
    return true
  }

  private read(): CloudProjectBindingDocument {
    const result = tryReadJsonFile<unknown>(this.filePath)
    if (result.status === 'missing') return { version: 1, bindings: [] }
    if (result.status === 'error') fail('CLOUD_BINDING_DOCUMENT_INVALID')
    return parseDocument(result.value)
  }

  private write(document: CloudProjectBindingDocument): void {
    writeJsonFile(this.filePath, parseDocument(document))
  }
}
