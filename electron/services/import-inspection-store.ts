import { randomUUID } from 'node:crypto'
import type { ImportInspectionSummary } from '../../src/shared/import-run'

export const MAX_IMPORT_CHAPTERS = 5_000
export const MAX_IMPORT_TOTAL_BYTES = 128 * 1024 * 1024
export const IMPORT_INSPECTION_TTL_MS = 10 * 60 * 1_000
const SHA256 = /^[a-f0-9]{64}$/u
const MAX_IMPORT_CHAPTER_BYTES = 16 * 1024 * 1024

export interface InspectedImportChapter {
  number: number
  title: string
  content: string
  wordCount: number
  contentFingerprint: string
  contentSize: number
}

export interface InspectedImportSource {
  stableFileId: string
  displayName: string
  mediaType: string
  size: number
}

export interface ImportInspection {
  inspectionId: string
  webContentsId: number
  sources: InspectedImportSource[]
  chapters: InspectedImportChapter[]
  totalWords: number
  totalBytes: number
  expiresAt: number
}

export interface ImportInspectionStoreOptions {
  now?: () => number
  ttlMs?: number
  maxActive?: number
  maxAggregateBytes?: number
}

export class ImportInspectionStore {
  private readonly inspections = new Map<string, ImportInspection>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxActive: number
  private readonly maxAggregateBytes: number

  constructor(options: ImportInspectionStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? IMPORT_INSPECTION_TTL_MS
    this.maxActive = options.maxActive ?? 2
    this.maxAggregateBytes = options.maxAggregateBytes ?? MAX_IMPORT_TOTAL_BYTES
  }

  create(input: {
    webContentsId: number
    sources: InspectedImportSource[]
    chapters: InspectedImportChapter[]
  }): ImportInspectionSummary {
    this.removeExpired()
    if (input.chapters.length === 0 || input.chapters.length > MAX_IMPORT_CHAPTERS) {
      throw new Error(`导入章节数必须在 1–${MAX_IMPORT_CHAPTERS} 之间`)
    }
    if (input.sources.length === 0 || input.sources.length > MAX_IMPORT_CHAPTERS) {
      throw new Error('导入来源数量无效')
    }
    const chapterNumbers = new Set<number>()
    let totalBytes = 0
    for (const chapter of input.chapters) {
      const bytes = Buffer.byteLength(chapter.content, 'utf8')
      if (
        !Number.isSafeInteger(chapter.number)
        || chapter.number < 1
        || chapterNumbers.has(chapter.number)
        || typeof chapter.title !== 'string'
        || !SHA256.test(chapter.contentFingerprint)
        || chapter.contentSize !== bytes
        || bytes > MAX_IMPORT_CHAPTER_BYTES
      ) throw new Error('导入章节检查数据无效')
      chapterNumbers.add(chapter.number)
      totalBytes += bytes
      if (totalBytes > MAX_IMPORT_TOTAL_BYTES) throw new Error('导入正文总字节数超过安全上限')
    }
    const retained = [...this.inspections.values()].filter(item => item.webContentsId !== input.webContentsId)
    const retainedBytes = retained.reduce((sum, item) => sum + item.totalBytes, 0)
    if (totalBytes > MAX_IMPORT_TOTAL_BYTES || retainedBytes + totalBytes > this.maxAggregateBytes) {
      throw new Error('导入正文总字节数超过安全上限')
    }
    if (retained.length >= this.maxActive) throw new Error('待处理导入检查过多，请先完成或取消现有检查')
    // One renderer session owns at most one pending inspection; reselection replaces it.
    this.revokeForWebContents(input.webContentsId)
    const inspectionId = randomUUID()
    const inspection: ImportInspection = {
      inspectionId,
      webContentsId: input.webContentsId,
      sources: input.sources,
      chapters: input.chapters,
      totalWords: input.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      totalBytes,
      expiresAt: this.now() + this.ttlMs,
    }
    this.inspections.set(inspectionId, inspection)
    return {
      inspectionId,
      chapterCount: inspection.chapters.length,
      totalWords: inspection.totalWords,
      totalBytes,
      preview: inspection.chapters.slice(0, 8).map(chapter => ({
        number: chapter.number,
        title: chapter.title,
        wordCount: chapter.wordCount,
      })),
    }
  }

  consume(inspectionId: string, webContentsId: number): ImportInspection {
    this.removeExpired()
    const inspection = this.inspections.get(inspectionId)
    if (!inspection || inspection.webContentsId !== webContentsId) throw new Error('导入检查已失效，请重新选择文件')
    this.inspections.delete(inspectionId)
    return inspection
  }

  revokeForWebContents(webContentsId: number): void {
    for (const [id, inspection] of this.inspections) {
      if (inspection.webContentsId === webContentsId) this.inspections.delete(id)
    }
  }

  activeCount(): number {
    this.removeExpired()
    return this.inspections.size
  }

  private removeExpired(): void {
    const now = this.now()
    for (const [id, inspection] of this.inspections) {
      if (inspection.expiresAt <= now) this.inspections.delete(id)
    }
  }
}

export const importInspectionStore = new ImportInspectionStore()
