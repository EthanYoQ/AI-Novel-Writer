import path from 'node:path'
import type { Readable } from 'node:stream'
import * as yauzl from 'yauzl'

export const EPUB_MAX_ARCHIVE_ENTRIES = 10_000
export const EPUB_MAX_ENTRY_BYTES = 32 * 1024 * 1024
export const EPUB_MAX_EXTRACTED_BYTES = 128 * 1024 * 1024

export type EpubExtractionErrorCode =
  | 'EPUB_DRM_UNSUPPORTED'
  | 'EPUB_EXPANSION_LIMIT'
  | 'EPUB_INVALID_ARCHIVE'

export class EpubExtractionError extends Error {
  constructor(readonly code: EpubExtractionErrorCode) {
    super(code)
    this.name = 'EpubExtractionError'
  }
}

export interface EpubChapter {
  title: string
  content: string
}

export interface EpubExtractionLimits {
  maxEntries: number
  maxEntryBytes: number
  maxExtractedBytes: number
}

const DEFAULT_LIMITS: Readonly<EpubExtractionLimits> = Object.freeze({
  maxEntries: EPUB_MAX_ARCHIVE_ENTRIES,
  maxEntryBytes: EPUB_MAX_ENTRY_BYTES,
  maxExtractedBytes: EPUB_MAX_EXTRACTED_BYTES,
})

interface ManifestItem {
  href: string
  mediaType: string
  properties: string
}

function invalidArchive(): never {
  throw new EpubExtractionError('EPUB_INVALID_ARCHIVE')
}

function normalizeArchivePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\')) invalidArchive()
  const normalized = path.posix.normalize(value.replace(/^\/+/, ''))
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    invalidArchive()
  }
  return normalized
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, body: string) => {
    if (body[0] !== '#') return named[body.toLowerCase()] ?? entity
    const hexadecimal = body[1]?.toLowerCase() === 'x'
    const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return entity
    }
  })
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gu)) {
    result[match[1].toLowerCase()] = decodeEntities(match[3])
  }
  return result
}

function firstTagAttributes(xml: string, localName: string): Record<string, string> | null {
  const expression = new RegExp(`<(?:[\\w-]+:)?${localName}\\b([^>]*)>`, 'iu')
  const match = expression.exec(xml)
  return match ? attributes(match[1]) : null
}

function allTagAttributes(xml: string, localName: string): Array<Record<string, string>> {
  const expression = new RegExp(`<(?:[\\w-]+:)?${localName}\\b([^>]*)>`, 'giu')
  return [...xml.matchAll(expression)].map(match => attributes(match[1]))
}

function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/?(?:address|article|aside|blockquote|div|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tr|ul)\b[^>]*>/giu, '\n\n')
    .replace(/<[^>]+>/gu, ''))
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => line.replace(/[\t ]+/gu, ' ').trim())
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function extractBody(document: string): string {
  return /<(?:[\w-]+:)?body\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?body>/iu.exec(document)?.[1]
    ?? document
}

function extractDocumentTitle(document: string, fallback: string): string {
  const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/iu.exec(document)?.[1]
  const title = /<(?:[\w-]+:)?title\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?title>/iu.exec(document)?.[1]
  return htmlToText(heading ?? title ?? '') || fallback
}

function openArchive(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zip) => {
      if (error || !zip) reject(new EpubExtractionError('EPUB_INVALID_ARCHIVE'))
      else resolve(zip)
    })
  })
}

function indexEntries(zip: yauzl.ZipFile, limits: EpubExtractionLimits): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>()
    const fail = (error: unknown) => {
      zip.close()
      reject(error instanceof EpubExtractionError ? error : new EpubExtractionError('EPUB_INVALID_ARCHIVE'))
    }
    zip.once('error', fail)
    zip.on('entry', (entry: yauzl.Entry) => {
      try {
        if (entries.size >= limits.maxEntries) {
          throw new EpubExtractionError('EPUB_EXPANSION_LIMIT')
        }
        const name = normalizeArchivePath(entry.fileName)
        if (entry.isEncrypted()) throw new EpubExtractionError('EPUB_DRM_UNSUPPORTED')
        if (entries.has(name)) invalidArchive()
        entries.set(name, entry)
        zip.readEntry()
      } catch (error) {
        fail(error)
      }
    })
    zip.once('end', () => resolve(entries))
    zip.readEntry()
  })
}

async function readEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  limits: EpubExtractionLimits,
  consumed: { bytes: number },
): Promise<string> {
  if (entry.uncompressedSize > limits.maxEntryBytes
    || entry.uncompressedSize > limits.maxExtractedBytes - consumed.bytes) {
    throw new EpubExtractionError('EPUB_EXPANSION_LIMIT')
  }
  const stream = await new Promise<Readable>((resolve, reject) => {
    zip.openReadStream(entry, (error, opened) => {
      if (error) reject(new EpubExtractionError('EPUB_INVALID_ARCHIVE'))
      else resolve(opened)
    })
  })
  const chunks: Buffer[] = []
  let entryBytes = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    entryBytes += bytes.length
    if (entryBytes > limits.maxEntryBytes || entryBytes > limits.maxExtractedBytes - consumed.bytes) {
      stream.destroy()
      throw new EpubExtractionError('EPUB_EXPANSION_LIMIT')
    }
    chunks.push(bytes)
  }
  consumed.bytes += entryBytes
  try {
    const content = Buffer.concat(chunks)
    if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(content)
    }
    if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
      return new TextDecoder('utf-16be', { fatal: true }).decode(content)
    }
    if (content.length >= 4 && content[0] === 0x3c && content[1] === 0x00
      && content[2] === 0x3f && content[3] === 0x00) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(content)
    }
    if (content.length >= 4 && content[0] === 0x00 && content[1] === 0x3c
      && content[2] === 0x00 && content[3] === 0x3f) {
      return new TextDecoder('utf-16be', { fatal: true }).decode(content)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new EpubExtractionError('EPUB_INVALID_ARCHIVE')
  }
}

/** Extracts only the textual EPUB reading order; images, CSS and reader layout are intentionally ignored. */
export async function extractEpubChapters(
  archive: Buffer,
  overrides: Partial<EpubExtractionLimits> = {},
): Promise<EpubChapter[]> {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  if (!Buffer.isBuffer(archive) || archive.length === 0) invalidArchive()
  const zip = await openArchive(archive)
  try {
    const entries = await indexEntries(zip, limits)
    if (entries.has('META-INF/encryption.xml')) {
      throw new EpubExtractionError('EPUB_DRM_UNSUPPORTED')
    }
    const containerEntry = entries.get('META-INF/container.xml')
    if (!containerEntry) invalidArchive()
    const consumed = { bytes: 0 }
    const container = await readEntry(zip, containerEntry, limits, consumed)
    const packagePath = firstTagAttributes(container, 'rootfile')?.['full-path']
    if (!packagePath) invalidArchive()
    const normalizedPackagePath = normalizeArchivePath(packagePath)
    const packageEntry = entries.get(normalizedPackagePath)
    if (!packageEntry) invalidArchive()
    const opf = await readEntry(zip, packageEntry, limits, consumed)
    const packageDirectory = path.posix.dirname(normalizedPackagePath)
    const manifest = new Map<string, ManifestItem>()
    for (const item of allTagAttributes(opf, 'item')) {
      if (!item.id || !item.href || manifest.has(item.id)) invalidArchive()
      manifest.set(item.id, {
        href: item.href,
        mediaType: item['media-type'] ?? '',
        properties: item.properties ?? '',
      })
    }

    const chapters: EpubChapter[] = []
    for (const itemref of allTagAttributes(opf, 'itemref')) {
      if (itemref.linear?.toLowerCase() === 'no') continue
      const item = itemref.idref ? manifest.get(itemref.idref) : undefined
      if (!item) invalidArchive()
      if (!['application/xhtml+xml', 'text/html'].includes(item.mediaType.toLowerCase())) continue
      if (item.properties.split(/\s+/u).includes('nav')) continue
      const relativeHref = item.href.split(/[?#]/u, 1)[0]
      let decodedHref: string
      try {
        decodedHref = decodeURIComponent(relativeHref)
      } catch {
        invalidArchive()
      }
      const documentPath = normalizeArchivePath(path.posix.join(packageDirectory, decodedHref))
      const documentEntry = entries.get(documentPath)
      if (!documentEntry) invalidArchive()
      const document = await readEntry(zip, documentEntry, limits, consumed)
      const body = htmlToText(extractBody(document))
      if (!body) continue
      chapters.push({
        title: extractDocumentTitle(document, path.posix.basename(documentPath, path.posix.extname(documentPath))),
        content: body,
      })
    }
    if (chapters.length === 0) invalidArchive()
    return chapters
  } catch (error) {
    if (error instanceof EpubExtractionError) throw error
    throw new EpubExtractionError('EPUB_INVALID_ARCHIVE')
  } finally {
    zip.close()
  }
}
