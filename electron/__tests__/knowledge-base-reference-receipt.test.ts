import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, initProjectDatabase } from '../database'
import { chunkText } from '../embedding'
import { importReferenceText } from '../knowledge-base'
import { ImportRunRepository } from '../repositories/import-run-repository'
import {
  addChunks,
  closeConnection,
  getConnection,
  getDocumentIntegrity,
  listDocuments,
  removeDocument,
} from '../vector-store'

let projectPath = ''
let authorizedRunIndex = 0
const model = { baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' }

function authorizedReference(content: string, sourceIdentity: string) {
  authorizedRunIndex += 1
  const sourceFingerprint = createHash('sha256').update(`source:${sourceIdentity}`).digest('hex')
  const contentFingerprint = createHash('sha256').update(content).digest('hex')
  const runId = `authorized-reference-${authorizedRunIndex}`
  const prepared = ImportRunRepository.prepare({
    runId,
    purpose: 'reference',
    sourceFingerprint,
    locale: 'en-US',
    sourceDisplay: [{ displayName: 'Chapter 1.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{
      number: 1,
      title: 'One',
      content,
      contentSize: Buffer.byteLength(content),
      contentFingerprint,
    }],
  })
  if (!prepared.run) throw new Error('Expected an import run')
  const chapterNumber = prepared.newChapterNumbers[0]
  if (!Number.isSafeInteger(chapterNumber)) throw new Error('Expected one new import chapter')
  const started = ImportRunRepository.startOrResume(prepared.run.id, `test-owner-${authorizedRunIndex}`)
  const idempotencyKey = `reference:${sourceFingerprint}:${chapterNumber}:${contentFingerprint}`
  return {
    idempotencyKey,
    import: (fileName: string) => importReferenceText(
      content,
      fileName,
      idempotencyKey,
      prepared.run!.id,
      { owner: started.execution.owner, epoch: started.execution.epoch },
      projectPath,
      'openai',
      model,
    ),
  }
}

beforeEach(() => {
  authorizedRunIndex = 0
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-reference-receipt-'))
  initProjectDatabase(projectPath)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  closeProjectDatabase()
  closeConnection(projectPath)
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe('stable reference knowledge receipt', () => {
  it('discards a delayed embedding result when its only import authority expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const content = 'Delayed reference content'
    const sourceFingerprint = 'a'.repeat(64)
    const contentFingerprint = createHash('sha256').update(content).digest('hex')
    const idempotencyKey = `reference:${sourceFingerprint}:1:${contentFingerprint}`
    ImportRunRepository.prepare({
      runId: 'delayed-authority-run',
      purpose: 'reference',
      sourceFingerprint,
      locale: 'en-US',
      sourceDisplay: [{ displayName: 'Chapter 1.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
      chapters: [{
        number: 1,
        title: 'One',
        content,
        contentSize: Buffer.byteLength(content),
        contentFingerprint,
      }],
    })
    const started = ImportRunRepository.startOrResume('delayed-authority-run', 'renderer-a', 1_000, 100)
    let finishEmbedding!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      finishEmbedding = resolve
    }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = importReferenceText(
      content,
      'Chapter 1.txt',
      idempotencyKey,
      'delayed-authority-run',
      { owner: started.execution.owner, epoch: started.execution.epoch },
      projectPath,
      'openai',
      { baseUrl: 'https://embedding.example/v1', apiKey: 'configured', modelName: 'embedding-model' },
    )
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    vi.setSystemTime(1_101)
    finishEmbedding(new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(pending).resolves.toMatchObject({ success: false })
    await expect(listDocuments(projectPath)).resolves.toEqual([])
  })

  it('hands one in-flight embedding result to the takeover authority without duplicate writes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(2_000)
    const content = 'Single-flight reference content'
    const sourceFingerprint = 'c'.repeat(64)
    const contentFingerprint = createHash('sha256').update(content).digest('hex')
    const idempotencyKey = `reference:${sourceFingerprint}:1:${contentFingerprint}`
    ImportRunRepository.prepare({
      runId: 'single-flight-run',
      purpose: 'reference',
      sourceFingerprint,
      locale: 'en-US',
      sourceDisplay: [{ displayName: 'Chapter 1.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
      chapters: [{
        number: 1,
        title: 'One',
        content,
        contentSize: Buffer.byteLength(content),
        contentFingerprint,
      }],
    })
    const first = ImportRunRepository.startOrResume('single-flight-run', 'renderer-a', 2_000, 100)
    const embeddingResponse = () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    let finishFirstEmbedding!: (response: Response) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishFirstEmbedding = resolve
      }))
      .mockImplementation(async () => embeddingResponse())
    vi.stubGlobal('fetch', fetchMock)
    const embeddingModel = {
      baseUrl: 'https://embedding.example/v1', apiKey: 'configured', modelName: 'embedding-model',
    }

    const oldExecution = importReferenceText(
      content,
      'Chapter 1.txt',
      idempotencyKey,
      'single-flight-run',
      { owner: first.execution.owner, epoch: first.execution.epoch },
      projectPath,
      'openai',
      embeddingModel,
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    vi.setSystemTime(2_101)
    const takeover = ImportRunRepository.startOrResume('single-flight-run', 'renderer-b', 2_101, 10_000)
    const currentExecution = importReferenceText(
      content,
      'Chapter 1.txt',
      idempotencyKey,
      'single-flight-run',
      { owner: takeover.execution.owner, epoch: takeover.execution.epoch },
      projectPath,
      'openai',
      embeddingModel,
    )
    finishFirstEmbedding(embeddingResponse())

    await expect(Promise.all([oldExecution, currentExecution])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const documents = await listDocuments(projectPath)
    expect(documents).toEqual([
      expect.objectContaining({ fileName: 'Chapter 1.txt', chunkCount: 1, corpusKind: 'reference' }),
    ])
    await expect(getDocumentIntegrity(projectPath, documents[0].id)).resolves.toMatchObject({
      complete: true,
      chunkCount: 1,
    })
  })

  it('stops embedding batches as soon as no registered authority remains current', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(3_000)
    const content = 'x'.repeat(250)
    const sourceFingerprint = 'd'.repeat(64)
    const contentFingerprint = createHash('sha256').update(content).digest('hex')
    const idempotencyKey = `reference:${sourceFingerprint}:1:${contentFingerprint}`
    ImportRunRepository.prepare({
      runId: 'batch-authority-run',
      purpose: 'reference',
      sourceFingerprint,
      locale: 'en-US',
      sourceDisplay: [{ displayName: 'Chapter 1.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
      chapters: [{
        number: 1,
        title: 'One',
        content,
        contentSize: Buffer.byteLength(content),
        contentFingerprint,
      }],
    })
    const started = ImportRunRepository.startOrResume('batch-authority-run', 'renderer-a', 3_000, 100)
    const embeddingResponse = () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    let finishFirstEmbedding!: (response: Response) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishFirstEmbedding = resolve
      }))
      .mockImplementation(async () => embeddingResponse())
    vi.stubGlobal('fetch', fetchMock)

    const pending = importReferenceText(
      content,
      'Chapter 1.txt',
      idempotencyKey,
      'batch-authority-run',
      { owner: started.execution.owner, epoch: started.execution.epoch },
      projectPath,
      'openai',
      {
        baseUrl: 'https://embedding.example/v1',
        apiKey: 'configured',
        modelName: 'embedding-model',
        embeddingOptions: { chunkSize: 100, chunkOverlap: 0, batchSize: 1 },
      },
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    vi.setSystemTime(3_101)
    finishFirstEmbedding(embeddingResponse())

    await expect(pending).resolves.toMatchObject({ success: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(listDocuments(projectPath)).resolves.toEqual([])
  })

  it('keeps same-name reference documents from distinct source identities and marks their corpus', async () => {
    const first = await authorizedReference('Source A reference', 'source-a').import('Chapter 1.txt')
    const second = await authorizedReference('Source B reference', 'source-b').import('Chapter 1.txt')

    expect(first).toMatchObject({ success: true, idempotent: false })
    expect(second).toMatchObject({ success: true, idempotent: false })
    expect(second.docId).not.toBe(first.docId)
    const documents = await listDocuments(projectPath)
    expect(documents.filter(document => document.fileName === 'Chapter 1.txt')).toHaveLength(2)
    expect(documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.docId, corpusKind: 'reference' }),
      expect.objectContaining({ id: second.docId, corpusKind: 'reference' }),
    ]))
  })

  it('does not trust a commit marker when the vector document is half-written', async () => {
    const content = `${'alpha '.repeat(500)}${'omega '.repeat(500)}`
    const key = 'source-half:chapter-1'
    const reference = authorizedReference(content, key)
    const first = await reference.import('Chapter 1.txt')
    expect(first).toMatchObject({ success: true, idempotent: false })
    const expectedChunks = chunkText(content)
    expect(expectedChunks.length).toBeGreaterThan(1)

    await removeDocument(projectPath, first.docId!)
    await addChunks(
      projectPath,
      first.docId!,
      'Chapter 1.txt',
      [expectedChunks[0]],
      undefined,
      undefined,
      { corpusKind: 'reference', replacementMode: 'stable-id' },
    )

    const replay = await reference.import('Chapter 1.txt')
    expect(replay).toMatchObject({ success: true, idempotent: false, docId: first.docId })
    await expect(getDocumentIntegrity(projectPath, first.docId!)).resolves.toMatchObject({
      corpusKind: 'reference',
      complete: true,
      chunkCount: expectedChunks.length,
    })
  })

  it('purges an embedding-only crash across reopen before replaying the stable reference', async () => {
    const content = 'Reference content that must have exactly one durable copy.'
    const key = 'source-embedding-only:chapter-1'
    const reference = authorizedReference(content, key)
    const documentId = createHash('sha256').update(`reference-import:${reference.idempotencyKey}`, 'utf8').digest('hex')
    const first = await reference.import('Chapter 1.txt')
    expect(first).toMatchObject({ success: true, docId: documentId })
    await expect(removeDocument(projectPath, documentId)).resolves.toBe(true)

    const chunks = chunkText(content)
    const vector = [0.1, 0.2, 0.3, 0.4]
    await expect(addChunks(
      projectPath,
      documentId,
      'Chapter 1.txt',
      chunks,
      chunks.map(() => vector),
      undefined,
      { corpusKind: 'reference', replacementMode: 'stable-id' },
      { modelFingerprint: 'test/embedding-only-replay', distanceMetric: 'l2' },
    )).resolves.toEqual({ success: true, chunkCount: chunks.length })
    const connection = await getConnection(projectPath)
    await (await connection.openTable('chunks')).delete(`\`docId\` = '${documentId}'`)
    await (await connection.openTable('documents')).delete(`id = '${documentId}'`)
    closeConnection(projectPath)

    await expect(getDocumentIntegrity(projectPath, documentId)).resolves.toMatchObject({
      complete: false,
      chunkCount: 0,
      embeddingGenerations: [expect.objectContaining({
        chunkCount: chunks.length,
        complete: false,
      })],
    })
    const replay = await reference.import('Chapter 1.txt')
    expect(replay).toMatchObject({ success: true, idempotent: false, docId: documentId })
    await expect(getDocumentIntegrity(projectPath, documentId)).resolves.toMatchObject({
      complete: true,
      chunkCount: chunks.length,
    })
    const reopened = await getConnection(projectPath)
    for (const tableName of (await reopened.tableNames()).filter(name => name.startsWith('chunks__space_'))) {
      expect(await (await reopened.openTable(tableName)).query()
        .filter(`\`docId\` = '${documentId}'`).toArray()).toEqual([])
    }
  })

  it.each(['chunks', 'document'] as const)(
    'rebuilds a stable reference when its %s commit side is missing',
    async missingSide => {
      const content = 'A stable reference chapter with enough text to verify.'
      const key = `source-orphan-${missingSide}:chapter-1`
      const reference = authorizedReference(content, key)
      const first = await reference.import('Chapter 1.txt')
      expect(first).toMatchObject({ success: true, idempotent: false })
      const connection = await getConnection(projectPath)
      const table = await connection.openTable(missingSide === 'chunks' ? 'chunks' : 'documents')
      const field = missingSide === 'chunks' ? 'docId' : 'id'
      await table.delete(`\`${field}\` = '${first.docId}'`)

      const replay = await reference.import('Chapter 1.txt')

      expect(replay).toMatchObject({ success: true, idempotent: false, docId: first.docId })
      await expect(getDocumentIntegrity(projectPath, first.docId!)).resolves.toMatchObject({
        complete: true,
        chunkCount: chunkText(content).length,
      })
    },
  )
})
