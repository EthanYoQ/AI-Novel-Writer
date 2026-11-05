import { createHash } from 'node:crypto'

import { getProjectDb } from '../database'
import { isWindowsFileBusyError } from '../utils/windows-file-busy-retry'
import { knowledgeBaseLoader } from './knowledge-base-loader'
import { removeManuscriptIfUnchanged, serializeManuscript } from './manuscript-publisher'

export interface ReplacedKnowledgeStore {
  readCopy(projectRoot: string, documentId: string): Promise<{ available: boolean; contentHash?: string; edited?: boolean }>
  remove(projectRoot: string, documentId: string): Promise<void>
}

const knowledgeStore: ReplacedKnowledgeStore = {
  async readCopy(projectRoot, documentId) {
    const copy = await knowledgeBaseLoader.run(kb => kb.readDocumentCopy(documentId, projectRoot))
    if ('errorCode' in copy) throw new Error(copy.errorCode)
    return copy
  },
  async remove(projectRoot, documentId) {
    const removed = await knowledgeBaseLoader.run(kb => kb.removeDocument(documentId, projectRoot))
    if (removed === true) return
    throw new Error(typeof removed === 'object' ? removed.errorCode : 'FINALIZATION_REPLACED_KNOWLEDGE_NOT_REMOVED')
  },
}

interface ReplacedFinal {
  chapter_title: string
  content_snapshot: string
  target_file_name: string
  knowledge_document_id: string
}

function readReplacement(draftId: number) {
  const db = getProjectDb()
  if (!db) throw new Error('PROJECT_NOT_OPEN')
  const current = db.prepare(`
    SELECT drafts.chapter_number, drafts.status, finalization_outbox.target_file_name,
           finalization_outbox.knowledge_document_id, finalization_outbox.publication_status
    FROM live_drafts AS drafts JOIN live_finalization_outbox AS finalization_outbox ON finalization_outbox.draft_id = drafts.id
    WHERE drafts.id = ?
  `).get(draftId) as {
    chapter_number: number
    status: string
    target_file_name: string
    knowledge_document_id: string
    publication_status: string
  } | undefined
  if (!current) throw new Error('FINALIZATION_COMMIT_NOT_FOUND')
  if (current.status !== 'finalized') throw new Error('FINALIZATION_SUPERSEDED')
  const replaced = db.prepare(`
    SELECT finalization_outbox.chapter_title, finalization_outbox.content_snapshot,
           finalization_outbox.target_file_name, finalization_outbox.knowledge_document_id
    FROM live_drafts AS drafts JOIN live_finalization_outbox AS finalization_outbox ON finalization_outbox.draft_id = drafts.id
    WHERE drafts.chapter_number = ? AND drafts.status = 'superseded'
    ORDER BY drafts.version, drafts.id
  `).all(current.chapter_number) as ReplacedFinal[]
  return { current, replaced }
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

export async function removeReplacedKnowledge(
  projectRoot: string,
  draftId: number,
  store: ReplacedKnowledgeStore = knowledgeStore,
): Promise<void> {
  const { current, replaced } = readReplacement(draftId)
  if (!current.knowledge_document_id) throw new Error('FINALIZATION_REPLACED_KNOWLEDGE_IMPORT_REQUIRED')
  let kept = false
  for (const row of replaced) {
    const documentId = row.knowledge_document_id
    if (!documentId) continue
    const copy = await store.readCopy(projectRoot, documentId)
    if (copy.available && (copy.edited || copy.contentHash !== sha256(row.content_snapshot))) {
      kept = true
      continue
    }
    await store.remove(projectRoot, documentId)
  }
  if (kept) throw new Error('FINALIZATION_REPLACED_KNOWLEDGE_EDITED')
}

export async function removeReplacedManuscripts(projectRoot: string, draftId: number): Promise<void> {
  const { current, replaced } = readReplacement(draftId)
  if (current.publication_status !== 'published') throw new Error('FINALIZATION_REPLACED_MANUSCRIPT_PUBLICATION_REQUIRED')
  const publishedByName = new Map<string, string[]>()
  for (const row of replaced) {
    if (!row.target_file_name || row.target_file_name === current.target_file_name) continue
    const published = serializeManuscript({ chapterNumber: current.chapter_number, chapterTitle: row.chapter_title, content: row.content_snapshot })
    publishedByName.set(row.target_file_name, [...publishedByName.get(row.target_file_name) ?? [], published])
  }
  const kept: string[] = []
  const busy: string[] = []
  for (const [fileName, published] of publishedByName) {
    try {
      if (removeManuscriptIfUnchanged(projectRoot, fileName, published) === 'changed') kept.push(fileName)
    } catch (error) {
      if (!isWindowsFileBusyError(error)) throw error
      busy.push(fileName)
    }
  }
  if (busy.length > 0) throw new Error(`FINALIZATION_REPLACED_MANUSCRIPT_BUSY:${JSON.stringify(busy)}`)
  if (kept.length > 0) throw new Error(`FINALIZATION_REPLACED_MANUSCRIPT_KEPT:${JSON.stringify(kept)}`)
}
