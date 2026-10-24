import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase } from '../database'
import { backfillVectors, captureWritingKnowledgeSnapshot, importReferenceText, importText, searchKnowledge } from '../knowledge-base'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { closeConnection } from '../vector-store'

let projectPath = ''
const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
  const { input } = JSON.parse(String(init.body)) as { input: string[] }
  return new Response(JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })
})

const LOCAL_MODELS = [
  { provider: 'ollama', baseUrl: 'http://192.168.1.20:11434/v1', apiKey: '', modelName: 'nomic-embed-text' },
  { provider: 'custom', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'local-embed' },
]
const CLOUD_MODEL = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', modelName: 'text-embedding-3-small' }

function embeddingRequests() {
  return fetchMock.mock.calls.map(([url]) => String(url))
}

function authorizedReference(content: string) {
  const contentFingerprint = createHash('sha256').update(content).digest('hex')
  const prepared = ImportRunRepository.prepare({
    runId: 'local-embedding-reference',
    purpose: 'reference',
    sourceFingerprint: 'b'.repeat(64),
    locale: 'en-US',
    sourceDisplay: [{ displayName: 'Chapter 1.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'One', content, contentSize: Buffer.byteLength(content), contentFingerprint }],
  })
  if (!prepared.run) throw new Error('Expected an import run')
  const started = ImportRunRepository.startOrResume(prepared.run.id, 'local-embedding-owner')
  const authority = { owner: started.execution.owner, epoch: started.execution.epoch }
  const { stableKey } = ImportRunRepository.resolveReferenceImportAuthority(prepared.run.id, authority, 1)
  return { runId: prepared.run.id, authority, stableKey }
}

beforeAll(() => { fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true }) })

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(path.resolve('.runtime/.cache'), 'ai-novel-kb-local-embedding-'))
  openCanonicalProjectFixture(projectPath)
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  closeProjectDatabase()
  closeConnection(projectPath)
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe.each(LOCAL_MODELS)('keyless $provider embedding model at $baseUrl', (model) => {
  const embeddingsUrl = `${model.baseUrl}/embeddings`

  it('embeds imported text, the search query and the writing snapshot query', async () => {
    await expect(importText('林岚核对潮位表。', '第1章 旧港.txt', projectPath, 'openai', model)).resolves.toMatchObject({ success: true })
    await searchKnowledge('潮位', projectPath, 'openai', model)
    await captureWritingKnowledgeSnapshot('潮位', projectPath, { protocol: 'openai', model })

    expect(embeddingRequests()).toEqual([embeddingsUrl, embeddingsUrl, embeddingsUrl])
  })

  it('rebuilds vectors for text that was indexed without them', async () => {
    await importText('守塔人记得每一次钟声。', '人物.md', projectPath, 'openai', model, { mode: 'fts-only' })
    expect(fetchMock).not.toHaveBeenCalled()

    await expect(backfillVectors(projectPath, 'openai', model)).resolves.toMatchObject({ success: true, failed: 0 })
    expect(embeddingRequests().length).toBeGreaterThan(0)
    expect(new Set(embeddingRequests())).toEqual(new Set([embeddingsUrl]))
  })

  it('embeds an authorized reference chapter', async () => {
    const content = 'Reference chapter for a local model.'
    const { runId, authority, stableKey } = authorizedReference(content)

    await expect(importReferenceText(content, 'Chapter 1.txt', stableKey, 1, runId, authority, projectPath, 'openai', model))
      .resolves.toMatchObject({ success: true })
    expect(embeddingRequests()).toEqual([embeddingsUrl])
  })
})

describe('keyless cloud embedding model', () => {
  it('never sends text to the provider and reports the model as not configured for a rebuild', async () => {
    await expect(importText('林岚核对潮位表。', '第1章 旧港.txt', projectPath, 'openai', CLOUD_MODEL)).resolves.toMatchObject({ success: true })
    await searchKnowledge('潮位', projectPath, 'openai', CLOUD_MODEL)
    await captureWritingKnowledgeSnapshot('潮位', projectPath, { protocol: 'openai', model: CLOUD_MODEL })
    await expect(backfillVectors(projectPath, 'openai', CLOUD_MODEL)).resolves.toMatchObject({ success: false, error: 'EMBEDDING_MODEL_NOT_CONFIGURED' })

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
