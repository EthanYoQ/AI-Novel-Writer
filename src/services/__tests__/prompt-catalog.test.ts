import { describe, expect, it, vi } from 'vitest'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { PromptCatalog, type PromptPersistence } from '../prompt-catalog'
import type { PromptTemplate } from '../prompt-templates'

const builtin: PromptTemplate = {
  key: 'first_chapter_draft',
  name: 'First chapter',
  description: 'Built in',
  content: 'builtin prompt',
  variables: {},
}

const session: ProjectSessionContext = {
  projectId: 'novel-1',
  leaseId: 'lease-1',
  projectPath: 'C:/novels/novel-1',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function persistence(overrides: Partial<PromptPersistence> = {}): PromptPersistence {
  return {
    loadGlobal: vi.fn(async () => ({ templates: [], diagnostics: [] })),
    loadProject: vi.fn(async () => ({ templates: [], diagnostics: [] })),
    saveGlobal: vi.fn(async () => {}),
    saveProject: vi.fn(async () => {}),
    deleteGlobal: vi.fn(async () => {}),
    deleteProject: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('PromptCatalog lifecycle', () => {
  it('hydrates a global override on the first resolve and shares one concurrent load', async () => {
    const globalLoad = deferred<{ templates: PromptTemplate[]; diagnostics: [] }>()
    const adapter = persistence({ loadGlobal: vi.fn(() => globalLoad.promise) })
    const catalog = new PromptCatalog([builtin], adapter, () => null)

    const first = catalog.resolve(builtin.key)
    const second = catalog.resolve(builtin.key)
    globalLoad.resolve({ templates: [{ ...builtin, content: 'global prompt' }], diagnostics: [] })

    await expect(first).resolves.toMatchObject({ template: { content: 'global prompt' }, source: 'global' })
    await expect(second).resolves.toMatchObject({ template: { content: 'global prompt' }, source: 'global' })
    expect(adapter.loadGlobal).toHaveBeenCalledTimes(1)
  })

  it('hydrates the active project override from resolve without a settings-page preload', async () => {
    const adapter = persistence({
      loadGlobal: vi.fn(async () => ({ templates: [{ ...builtin, content: 'global prompt' }], diagnostics: [] })),
      loadProject: vi.fn(async () => ({ templates: [{ ...builtin, content: 'project prompt' }], diagnostics: [] })),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => session)

    await expect(catalog.resolve(builtin.key, session)).resolves.toMatchObject({
      template: { content: 'project prompt' },
      source: 'project',
    })
    expect(adapter.loadProject).toHaveBeenCalledWith(session)
  })

  it('publishes a successful save immediately to subsequent resolves', async () => {
    const adapter = persistence()
    const catalog = new PromptCatalog([builtin], adapter, () => null)
    const saved = { ...builtin, content: 'saved prompt' }

    await expect(catalog.commit({ action: 'save', scope: 'global', template: saved })).resolves.toBe(true)
    await expect(catalog.resolve(builtin.key)).resolves.toMatchObject({
      template: { content: 'saved prompt' },
      source: 'global',
    })
  })

  it('does not publish a save when durable persistence fails', async () => {
    const adapter = persistence({
      saveGlobal: vi.fn(async () => { throw new Error('disk full') }),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => null)

    await expect(catalog.commit({
      action: 'save',
      scope: 'global',
      template: { ...builtin, content: 'must not leak' },
    })).resolves.toBe(false)
    await expect(catalog.resolve(builtin.key)).resolves.toMatchObject({
      template: { content: 'builtin prompt' },
      source: 'builtin',
    })
  })

  it('fails visibly instead of treating a project load error as no override', async () => {
    const adapter = persistence({
      loadProject: vi.fn(async () => { throw new Error('permission denied') }),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => session)

    await expect(catalog.resolve(builtin.key, session)).rejects.toThrow('permission denied')
  })

  it('fails closed only for the key whose project override is damaged', async () => {
    const adapter = persistence({
      loadProject: vi.fn(async () => ({
        templates: [{ ...builtin, key: 'next_chapter_draft', content: 'valid project prompt' }],
        diagnostics: [{ key: builtin.key, path: 'first_chapter_draft.json', error: 'JSON 格式损坏' }],
      })),
    })
    const catalog = new PromptCatalog([
      builtin,
      { ...builtin, key: 'next_chapter_draft', content: 'next builtin' },
    ], adapter, () => session)

    await expect(catalog.resolve(builtin.key, session)).rejects.toThrow('first_chapter_draft.json')
    await expect(catalog.resolve('next_chapter_draft', session)).resolves.toMatchObject({
      template: { content: 'valid project prompt' },
      source: 'project',
    })
  })

  it('reports a damaged global target while unrelated built-ins remain resolvable', async () => {
    const adapter = persistence({
      loadGlobal: vi.fn(async () => ({
        templates: [],
        diagnostics: [{ key: builtin.key, path: 'first_chapter_draft.json', error: '内容结构无效' }],
      })),
    })
    const catalog = new PromptCatalog([
      builtin,
      { ...builtin, key: 'next_chapter_draft', content: 'next builtin' },
    ], adapter, () => null)

    await expect(catalog.resolve(builtin.key)).rejects.toThrow('内容结构无效')
    await expect(catalog.resolve('next_chapter_draft')).resolves.toMatchObject({
      template: { content: 'next builtin' },
      source: 'builtin',
    })
    await expect(catalog.list()).rejects.toThrow('first_chapter_draft.json')
  })

  it('does not leak project diagnostics into a global-only list', async () => {
    const adapter = persistence({
      loadProject: vi.fn(async () => ({
        templates: [],
        diagnostics: [{ key: builtin.key, path: 'project/first_chapter_draft.json', error: 'project damaged' }],
      })),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => session)

    await expect(catalog.resolve(builtin.key, session)).rejects.toThrow('project damaged')
    await expect(catalog.list()).resolves.toEqual([{
      template: builtin,
      source: 'builtin',
    }])
  })
})
