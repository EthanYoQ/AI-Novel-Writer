import { createHash } from 'node:crypto'

import { getProjectDb } from '../database'
import { isWindowsFileBusyError } from '../utils/windows-file-busy-retry'
import { knowledgeBaseLoader } from './knowledge-base-loader'
import { removeManuscriptIfUnchanged, serializeManuscript } from './manuscript-publisher'

/** 知识库里的文档副本与删除；测试换成桩。 */
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

/** 这份定稿与本章被它（及更早的替换）换下的各份定稿；数据从 superseded 行派生，不另存（ADR-0024）。 */
function readReplacement(draftId: number) {
  const db = getProjectDb()
  if (!db) throw new Error('PROJECT_NOT_OPEN')
  const current = db.prepare(`
    SELECT drafts.chapter_number, drafts.status, finalization_outbox.target_file_name,
           finalization_outbox.knowledge_document_id, finalization_outbox.publication_status
    FROM drafts JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
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
    FROM drafts JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
    WHERE drafts.chapter_number = ? AND drafts.status = 'superseded'
    ORDER BY drafts.version, drafts.id
  `).all(current.chapter_number) as ReplacedFinal[]
  return { current, replaced }
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * 删除本章被替换的旧定稿收进知识库的文档。新定稿的文档登记之前不动旧的，免得这一章在知识库里空着。
 * 章名没改时，导入新文档那一步已按同名换掉旧文档（vector-store 的 pruneSupersededDocuments），这里清其余的。
 * 副本和旧定稿正文对不上的（作者以前改过）保留并报错，重试也不删。没有完整副本的无从改起，照常删。
 */
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

/**
 * 删除本章被替换的旧定稿的实体稿。新定稿的实体稿写入之前不动旧的；和当前定稿同名的文件属于当前定稿，不碰。
 * 旧文件删掉后原名会被后来的定稿再用，所以同一个文件名按用过它的各份旧定稿的发布内容一起认。
 * 内容仍是当初发布的样子才删，改过的保留；被占用删不掉的单独报。错误码后带 JSON 文件名列表，说明里列出。
 */
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
