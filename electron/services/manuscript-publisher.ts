import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { retryWhileWindowsFileBusy } from '../utils/windows-file-busy-retry'

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
  /** 还没清理完的删除收据占着的文件名（小写）。文件可能还在也可能不在，都不能拿来发布，否则续跑清理会删掉它。 */
  reserved?: ReadonlySet<string>
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
    throw new Error('MANUSCRIPT_TARGET_OUTSIDE_PROJECT')
  }
  return { fileName, absolutePath }
}

/**
 * 生成仅属于受信项目根目录的实体稿路径。目标名称会在 SQLite outbox 中冻结，
 * 重试绝不重新接受渲染进程提供的路径或标题。
 */
export function resolveManuscriptTarget(input: ManuscriptTargetInput): ManuscriptTarget {
  if (!Number.isInteger(input.chapterNumber) || input.chapterNumber < 1) {
    throw new Error('MANUSCRIPT_CHAPTER_NUMBER_INVALID')
  }
  const preferred = manuscriptFileName(input.chapterNumber, input.chapterTitle)
  const taken = (target: ManuscriptTarget) => fs.existsSync(target.absolutePath)
    || (input.reserved?.has(target.fileName.toLowerCase()) ?? false)
  const first = containedDirectChild(input.projectRoot, preferred)
  if (!taken(first)) return first

  const parsed = path.parse(preferred)
  const collisionMarker = sanitizeWindowsFileNamePart(input.finalizationId).slice(0, 12) || 'finalized'
  for (let index = 1; index < 1000; index += 1) {
    const suffix = index === 1 ? ` (${collisionMarker})` : ` (${collisionMarker}-${index})`
    const candidate = containedDirectChild(input.projectRoot, `${parsed.name}${suffix}${parsed.ext}`)
    if (!taken(candidate)) return candidate
  }
  throw new Error('MANUSCRIPT_TARGET_COLLISIONS')
}

function resolveStoredManuscriptTarget(projectRoot: string, targetFileName: string): ManuscriptTarget {
  if (!targetFileName || targetFileName !== path.basename(targetFileName)) {
    throw new Error('MANUSCRIPT_STORED_TARGET_INVALID')
  }
  return containedDirectChild(projectRoot, targetFileName)
}

/**
 * 重新发布一份已冻结目标的定稿（从回收站恢复）。目标空着或已是同一内容就沿用；作者在删除后放了同名的
 * 其他东西（文件、文件夹、读不了的文件），原目标还被没清理完的删除收据占着，或旧收据的目标名不合法时，换一个不撞名的目标，
 * 否则发布永远失败，这一章也就放不回去。
 */
export function republishTarget(input: PublishManuscriptInput & Pick<ManuscriptTargetInput, 'finalizationId' | 'reserved'>): string {
  let stored: ManuscriptTarget
  try { stored = resolveStoredManuscriptTarget(input.projectRoot, input.targetFileName) }
  catch { return resolveManuscriptTarget(input).fileName }
  if (input.reserved?.has(stored.fileName.toLowerCase())) return resolveManuscriptTarget(input).fileName
  if (!fs.existsSync(stored.absolutePath)) return stored.fileName
  try {
    if (fs.statSync(stored.absolutePath).isFile() && fs.readFileSync(stored.absolutePath, 'utf8') === serializeManuscript(input)) {
      return stored.fileName
    }
  } catch { /* 读不了的占位与不同内容一样，换目标。 */ }
  return resolveManuscriptTarget(input).fileName
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
    throw new Error('MANUSCRIPT_TARGET_CONFLICT')
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

/**
 * 删除 outbox 中已冻结的实体稿目标。缺失文件表示投影已经清理，按幂等成功处理。
 */
export async function removePublishedManuscript(
  projectRoot: string,
  targetFileName: string,
): Promise<void> {
  const target = resolveStoredManuscriptTarget(projectRoot, targetFileName)
  if (!fs.existsSync(target.absolutePath)) return
  fs.unlinkSync(target.absolutePath)
}

export function removeManuscriptIfUnchanged(
  projectRoot: string,
  targetFileName: string,
  published: readonly string[],
): 'removed' | 'missing' | 'changed' {
  const target = resolveStoredManuscriptTarget(projectRoot, targetFileName)
  try {
    return retryWhileWindowsFileBusy(() => {
      if (!published.includes(fs.readFileSync(target.absolutePath, 'utf8'))) return 'changed'
      fs.unlinkSync(target.absolutePath)
      return 'removed'
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

export const manuscriptPublisher = {
  publish: publishManuscript,
  remove: removePublishedManuscript,
}
