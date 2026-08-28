import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, initProjectDatabase } from '../database'
import { chunkText } from '../embedding'
import { importReferenceText } from '../knowledge-base'
import {
  addChunks,
  closeConnection,
  getConnection,
  getDocumentIntegrity,
  listDocuments,
  removeDocument,
} from '../vector-store'

let projectPath = ''
const model = { baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' }

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-reference-receipt-'))
  initProjectDatabase(projectPath)
})

afterEach(() => {
  closeProjectDatabase()
  closeConnection(projectPath)
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe('stable reference knowledge receipt', () => {
  it('keeps same-name reference documents from distinct source identities and marks their corpus', async () => {
    const first = await importReferenceText(
      'Source A reference', 'Chapter 1.txt', 'source-a:chapter-1', projectPath, 'openai', model,
    )
    const second = await importReferenceText(
      'Source B reference', 'Chapter 1.txt', 'source-b:chapter-1', projectPath, 'openai', model,
    )

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
    const first = await importReferenceText(
      content, 'Chapter 1.txt', key, projectPath, 'openai', model,
    )
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

    const replay = await importReferenceText(
      content, 'Chapter 1.txt', key, projectPath, 'openai', model,
    )
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
    const documentId = createHash('sha256').update(`reference-import:${key}`, 'utf8').digest('hex')
    const first = await importReferenceText(
      content, 'Chapter 1.txt', key, projectPath, 'openai', model,
    )
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
    const replay = await importReferenceText(
      content, 'Chapter 1.txt', key, projectPath, 'openai', model,
    )
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
      const first = await importReferenceText(
        content, 'Chapter 1.txt', key, projectPath, 'openai', model,
      )
      expect(first).toMatchObject({ success: true, idempotent: false })
      const connection = await getConnection(projectPath)
      const table = await connection.openTable(missingSide === 'chunks' ? 'chunks' : 'documents')
      const field = missingSide === 'chunks' ? 'docId' : 'id'
      await table.delete(`\`${field}\` = '${first.docId}'`)

      const replay = await importReferenceText(
        content, 'Chapter 1.txt', key, projectPath, 'openai', model,
      )

      expect(replay).toMatchObject({ success: true, idempotent: false, docId: first.docId })
      await expect(getDocumentIntegrity(projectPath, first.docId!)).resolves.toMatchObject({
        complete: true,
        chunkCount: chunkText(content).length,
      })
    },
  )
})
