import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const WINDOWS_ILLEGAL_FILE_NAME_CHARS = /[<>:"/\\|?*]/g
const WINDOWS_RESERVED_FILE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function replaceWindowsControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint <= 0x1f ? '_' : character
  }).join('')
}

export interface ManuscriptTargetInput {
  projectRoot: string
  chapterNumber: number
  chapterTitle: string
  finalizationId: string
}

export interface ManuscriptTarget {
  fileName: string
  absolutePath: string
}

export interface PublishManuscriptInput {
  projectRoot: string
  targetFileName: string
  chapterNumber: number
  chapterTitle: string
  content: string
}

function sanitizeWindowsFileNamePart(value: string): string {
  const normalized = replaceWindowsControlCharacters(
    value.replace(WINDOWS_ILLEGAL_FILE_NAME_CHARS, '_'),
  )
    .trim()
    .replace(/[. ]+$/g, '')
  if (!normalized) return ''
  return WINDOWS_RESERVED_FILE_NAME.test(normalized)
    ? `${normalized}_`
    : normalized
}

function manuscriptFileName(chapterNumber: number, chapterTitle: string): string {
  const title = sanitizeWindowsFileNamePart(chapterTitle)
  return title ? `第${chapterNumber}章 ${title}.txt` : `第${chapterNumber}章.txt`
}

function containedDirectChild(projectRoot: string, fileName: string): ManuscriptTarget {
  const root = path.resolve(projectRoot)
  const absolutePath = path.resolve(root, fileName)
  if (path.dirname(absolutePath) !== root || path.basename(absolutePath) !== fileName) {
    throw new Error('实体稿目标越出受信项目 manuscript 边界')
  }
  return { fileName, absolutePath }
}

/**
 * 生成仅属于受信项目根目录的实体稿路径。目标名称会在 SQLite outbox 中冻结，
 * 重试绝不重新接受渲染进程提供的路径或标题。
 */
export function resolveManuscriptTarget(input: ManuscriptTargetInput): ManuscriptTarget {
  if (!Number.isInteger(input.chapterNumber) || input.chapterNumber < 1) {
    throw new Error('章节号无效，无法生成实体稿目标')
  }
  const preferred = manuscriptFileName(input.chapterNumber, input.chapterTitle)
  const first = containedDirectChild(input.projectRoot, preferred)
  if (!fs.existsSync(first.absolutePath)) return first

  const parsed = path.parse(preferred)
  const collisionMarker = sanitizeWindowsFileNamePart(input.finalizationId).slice(0, 12) || 'finalized'
  for (let index = 1; index < 1000; index += 1) {
    const suffix = index === 1 ? ` (${collisionMarker})` : ` (${collisionMarker}-${index})`
    const candidate = containedDirectChild(input.projectRoot, `${parsed.name}${suffix}${parsed.ext}`)
    if (!fs.existsSync(candidate.absolutePath)) return candidate
  }
  throw new Error('实体稿文件名碰撞过多，拒绝覆盖现有文件')
}

function resolveStoredManuscriptTarget(projectRoot: string, targetFileName: string): ManuscriptTarget {
  if (!targetFileName || targetFileName !== path.basename(targetFileName)) {
    throw new Error('已提交的实体稿目标无效')
  }
  return containedDirectChild(projectRoot, targetFileName)
}

export function serializeManuscript(input: Omit<PublishManuscriptInput, 'projectRoot' | 'targetFileName'>): string {
  const title = sanitizeWindowsFileNamePart(input.chapterTitle)
  const header = title
    ? `第${input.chapterNumber}章 ${title}\n\n`
    : `第${input.chapterNumber}章\n\n`
  return header + input.content.replace(/^#+ .*\r?\n*/, '')
}

/**
 * 临时文件写入后在同一目录原位 rename。若重试时发现同内容目标已存在，视为
 * 上次 rename 成功但状态回写中断，保持幂等；不同内容则永不覆盖。
 */
export async function publishManuscript(input: PublishManuscriptInput): Promise<void> {
  const target = resolveStoredManuscriptTarget(input.projectRoot, input.targetFileName)
  const serialized = serializeManuscript(input)
  if (fs.existsSync(target.absolutePath)) {
    const current = fs.readFileSync(target.absolutePath, 'utf8')
    if (current === serialized) return
    throw new Error(`实体稿目标已存在且内容不匹配：${target.fileName}`)
  }

  const temporary = containedDirectChild(
    input.projectRoot,
    `.${target.fileName}.${randomUUID()}.tmp`,
  )
  try {
    fs.writeFileSync(temporary.absolutePath, serialized, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(temporary.absolutePath, target.absolutePath)
  } finally {
    if (fs.existsSync(temporary.absolutePath)) {
      fs.unlinkSync(temporary.absolutePath)
    }
  }
}

export const manuscriptPublisher = {
  publish: publishManuscript,
}
