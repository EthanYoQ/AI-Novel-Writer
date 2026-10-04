import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CLOUD_BACKUP_BINDINGS_FILE,
  CloudProjectBindingStore,
} from '../cloud-project-binding-store'

const PROJECT_A = '11111111-1111-4111-8111-111111111111'
const PROJECT_B = '22222222-2222-4222-8222-222222222222'
const roots: string[] = []

function fixture(): { root: string; file: string; store: CloudProjectBindingStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-cloud-bindings-'))
  roots.push(root)
  return {
    root,
    file: path.join(root, CLOUD_BACKUP_BINDINGS_FILE),
    store: new CloudProjectBindingStore(root),
  }
}

function writable(overrides: Partial<Parameters<CloudProjectBindingStore['saveWritable']>[0]> = {}) {
  return {
    localProjectId: PROJECT_A,
    cloudBookId: 'cloud-book-a',
    localEndpointAccountId: 'account-a',
    lastSelectedParentGenerationIds: ['generation-a'],
    expectedRevision: null,
    ...overrides,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('CloudProjectBindingStore', () => {
  it('treats a missing canonical document as an empty store', () => {
    const { store } = fixture()

    expect(store.get(PROJECT_A)).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('creates and updates writable bindings with monotonic CAS revisions', () => {
    const { file, store } = fixture()

    expect(store.saveWritable(writable({
      lastSelectedParentGenerationIds: ['generation-a', 'generation-a', 'generation-b'],
    }))).toEqual({
      localProjectId: PROJECT_A,
      cloudBookId: 'cloud-book-a',
      localEndpointAccountId: 'account-a',
      lastSelectedParentGenerationIds: ['generation-a', 'generation-b'],
      mode: 'writable',
      revision: 1,
    })
    expect(store.saveWritable(writable({
      cloudBookId: 'cloud-book-rebound',
      localEndpointAccountId: 'account-b',
      lastSelectedParentGenerationIds: ['generation-c'],
      expectedRevision: 1,
    }))).toMatchObject({
      cloudBookId: 'cloud-book-rebound',
      localEndpointAccountId: 'account-b',
      lastSelectedParentGenerationIds: ['generation-c'],
      mode: 'writable',
      revision: 2,
    })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, bindings: [store.get(PROJECT_A)] })
  })

  it('rejects a stale upload completion without overwriting a newer rebind', () => {
    const { file, store } = fixture()
    store.saveWritable(writable())
    store.saveWritable(writable({
      cloudBookId: 'cloud-book-new',
      lastSelectedParentGenerationIds: ['generation-new-parent'],
      expectedRevision: 1,
    }))
    const bytesBefore = fs.readFileSync(file)

    expect(() => store.saveWritable(writable({
      lastSelectedParentGenerationIds: ['stale-upload-generation'],
      expectedRevision: 1,
    }))).toThrow('CLOUD_BINDING_REVISION_CONFLICT')
    expect(fs.readFileSync(file)).toEqual(bytesBefore)
    expect(store.get(PROJECT_A)).toMatchObject({
      cloudBookId: 'cloud-book-new',
      lastSelectedParentGenerationIds: ['generation-new-parent'],
      revision: 2,
    })
  })

  it('persists an origin-readonly restore and requires revision CAS for explicit writable rebinding', () => {
    const { root, store } = fixture()
    const restored = store.saveOriginReadonly({
      localProjectId: PROJECT_A,
      cloudBookId: 'cloud-book-a',
      localEndpointAccountId: 'account-a',
      lastSelectedParentGenerationIds: ['origin-generation'],
    })

    expect(restored).toMatchObject({ mode: 'origin-readonly', revision: 1 })
    expect(new CloudProjectBindingStore(root).get(PROJECT_A)).toEqual(restored)
    expect(store.saveOriginReadonly({
      localProjectId: PROJECT_A,
      cloudBookId: 'cloud-book-a',
      localEndpointAccountId: 'account-a',
      lastSelectedParentGenerationIds: ['origin-generation'],
    })).toEqual(restored)
    expect(store.saveWritable(writable({
      lastSelectedParentGenerationIds: ['origin-generation'],
      expectedRevision: 1,
    }))).toMatchObject({ mode: 'writable', revision: 2 })
  })

  it('marks every binding for a cleared account unconfigured without dropping ownership history', () => {
    const { store } = fixture()
    store.saveWritable(writable())
    store.saveOriginReadonly({
      localProjectId: PROJECT_B,
      cloudBookId: 'cloud-book-b',
      localEndpointAccountId: 'account-a',
      lastSelectedParentGenerationIds: ['generation-b'],
    })

    expect(store.markAccountUnconfigured('account-a')).toBe(2)
    expect(store.list()).toEqual([
      {
        localProjectId: PROJECT_A,
        cloudBookId: 'cloud-book-a',
        localEndpointAccountId: 'account-a',
        lastSelectedParentGenerationIds: ['generation-a'],
        mode: 'unconfigured',
        revision: 2,
      },
      {
        localProjectId: PROJECT_B,
        cloudBookId: 'cloud-book-b',
        localEndpointAccountId: 'account-a',
        lastSelectedParentGenerationIds: ['generation-b'],
        mode: 'unconfigured',
        revision: 2,
      },
    ])
    expect(store.markAccountUnconfigured('account-a')).toBe(0)
  })

  it('removes only a confirmed deleted project binding', () => {
    const { store } = fixture()
    store.saveWritable(writable())
    store.saveWritable(writable({ localProjectId: PROJECT_B }))

    expect(store.removeDeletedProject(PROJECT_A)).toBe(true)
    expect(store.get(PROJECT_A)).toBeNull()
    expect(store.get(PROJECT_B)).not.toBeNull()
    expect(store.removeDeletedProject(PROJECT_A)).toBe(false)
  })

  it.each([
    ['malformed JSON', '{not json'],
    ['unknown version', JSON.stringify({ version: 2, bindings: [] })],
    ['unknown field', JSON.stringify({ version: 1, bindings: [], extra: true })],
    ['duplicate persisted parent', JSON.stringify({ version: 1, bindings: [{
      localProjectId: PROJECT_A,
      cloudBookId: 'cloud-book-a',
      localEndpointAccountId: 'account-a',
      lastSelectedParentGenerationIds: ['generation-a', 'generation-a'],
      mode: 'writable',
      revision: 1,
    }] })],
  ])('fails closed for %s and preserves the original bytes', (_label, raw) => {
    const { file, store } = fixture()
    fs.writeFileSync(file, raw)
    const before = fs.readFileSync(file)

    expect(() => store.list()).toThrow('CLOUD_BINDING_DOCUMENT_INVALID')
    expect(() => store.saveWritable(writable())).toThrow('CLOUD_BINDING_DOCUMENT_INVALID')
    expect(() => store.removeDeletedProject(PROJECT_A)).toThrow('CLOUD_BINDING_DOCUMENT_INVALID')
    expect(fs.readFileSync(file)).toEqual(before)
  })

  it('rejects invalid IDs, modes, revisions, and duplicate project records', () => {
    const { file, store } = fixture()
    expect(() => store.saveWritable(writable({ cloudBookId: '../outside' }))).toThrow('CLOUD_BINDING_INPUT_INVALID')
    expect(() => store.saveWritable(writable({ expectedRevision: 0 }))).toThrow('CLOUD_BINDING_INPUT_INVALID')

    fs.writeFileSync(file, JSON.stringify({ version: 1, bindings: [
      { ...writable(), mode: 'writable', revision: 1, expectedRevision: undefined },
      { ...writable(), mode: 'origin-readonly', revision: 2, expectedRevision: undefined },
    ] }))
    expect(() => store.list()).toThrow('CLOUD_BINDING_DOCUMENT_INVALID')
  })
})
