import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  inspectWritingSkillMarkdown,
  MAX_WRITING_SKILL_BYTES,
  WRITING_SKILL_TEXT_EXTENSIONS,
  type LocalWritingSkillSourceKind,
  type WritingSkillInspection,
} from '../../src/shared/writing-skills'

const MAX_FOLDER_ENTRIES = 200
const MAX_FOLDER_DEPTH = 4

export type WritingSkillPackageErrorCode =
  | 'SOURCE_INVALID'
  | 'SYMLINK'
  | 'SKILL_MD_MISSING'
  | 'SKILL_MD_INVALID'
  | 'FOLDER_TOO_LARGE'

export class WritingSkillPackageError extends Error {
  constructor(readonly code: WritingSkillPackageErrorCode) {
    super(code)
  }
}

export interface WritingSkillSource {
  kind: LocalWritingSkillSourceKind
  /** 主进程对话框返回的绝对路径；不接受渲染层传入。 */
  path: string
}

export interface LoadedWritingSkillPackage {
  raw: string
  inspection: WritingSkillInspection
  /** 并入提示词的附带文件，按 inspection.bundledFiles 的路径存放读到的原文。 */
  bundledFiles: Map<string, string>
  skippedFiles: string[]
  sourceName: string
  contentSha256: string
}

/** 读取一个普通 UTF-8 文本文件；链接、非普通文件、超限或非 UTF-8 一律拒绝。 */
function readTextFile(filePath: string): string | undefined {
  const info = fs.lstatSync(filePath)
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_WRITING_SKILL_BYTES) return undefined
  const bytes = fs.readFileSync(filePath)
  if (bytes.length > MAX_WRITING_SKILL_BYTES || bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * 按 Skill 根目录读取附带文本。逐段 lstat，路径上任何一段是链接或不是目录都视为不存在，
 * 已安装的 Skill 与刚选中的文件夹共用这条读取规则。
 */
export function skillDirectoryFileReader(root: string, record?: Map<string, string>) {
  return (relativePath: string): string | undefined => {
    const segments = relativePath.split('/')
    if (!WRITING_SKILL_TEXT_EXTENSIONS.some(extension => relativePath.toLowerCase().endsWith(extension))) return undefined
    let cursor = root
    try {
      for (const segment of segments.slice(0, -1)) {
        cursor = path.join(cursor, segment)
        const info = fs.lstatSync(cursor)
        if (info.isSymbolicLink() || !info.isDirectory()) return undefined
      }
      const content = readTextFile(path.join(cursor, segments[segments.length - 1]))
      if (content !== undefined) record?.set(relativePath, content)
      return content
    } catch {
      return undefined
    }
  }
}

/** 列出文件夹内的文件（POSIX 相对路径），遇到链接整体拒绝；以点开头的条目（如 .git）不计入。 */
function listFolderFiles(root: string): string[] {
  const files: string[] = []
  let visited = 0
  const walk = (directory: string, prefix: string, depth: number) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (++visited > MAX_FOLDER_ENTRIES) throw new WritingSkillPackageError('FOLDER_TOO_LARGE')
      const absolute = path.join(directory, entry.name)
      const info = fs.lstatSync(absolute)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (info.isSymbolicLink()) throw new WritingSkillPackageError('SYMLINK')
      if (info.isDirectory()) {
        if (depth >= MAX_FOLDER_DEPTH) throw new WritingSkillPackageError('FOLDER_TOO_LARGE')
        walk(absolute, relative, depth + 1)
      } else {
        files.push(relative)
      }
    }
  }
  walk(root, '', 1)
  return files
}

function fileFallbackName(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath))
  return stem.toLowerCase() === 'skill' ? path.basename(path.dirname(filePath)) : stem
}

function packageSha256(raw: string, bundledFiles: Map<string, string>): string {
  return createHash('sha256').update(JSON.stringify([raw, ...bundledFiles]), 'utf8').digest('hex')
}

/** 读取并检查一个本机 SKILL.md 文件或 Skill 文件夹；只读，不写任何位置。 */
export function loadLocalWritingSkill(source: WritingSkillSource): LoadedWritingSkillPackage {
  if (!path.isAbsolute(source.path)) throw new WritingSkillPackageError('SOURCE_INVALID')
  let info: fs.Stats
  try {
    info = fs.lstatSync(source.path)
  } catch {
    throw new WritingSkillPackageError('SOURCE_INVALID')
  }
  if (info.isSymbolicLink()) throw new WritingSkillPackageError('SYMLINK')

  const bundledFiles = new Map<string, string>()
  if (source.kind === 'file') {
    if (!info.isFile() || !/\.(?:md|markdown)$/i.test(source.path)) throw new WritingSkillPackageError('SOURCE_INVALID')
    const raw = readTextFile(source.path)
    if (raw === undefined) throw new WritingSkillPackageError('SKILL_MD_INVALID')
    const inspection = inspectWritingSkillMarkdown(raw, { fallbackName: fileFallbackName(source.path) })
    return {
      raw,
      inspection,
      bundledFiles,
      skippedFiles: [],
      sourceName: path.basename(source.path),
      contentSha256: packageSha256(raw, bundledFiles),
    }
  }

  if (!info.isDirectory()) throw new WritingSkillPackageError('SOURCE_INVALID')
  const files = listFolderFiles(source.path)
  const skillFile = files.find(file => file.toLowerCase() === 'skill.md')
  if (!skillFile) throw new WritingSkillPackageError('SKILL_MD_MISSING')
  const raw = readTextFile(path.join(source.path, skillFile))
  if (raw === undefined) throw new WritingSkillPackageError('SKILL_MD_INVALID')
  const inspection = inspectWritingSkillMarkdown(raw, {
    readFile: skillDirectoryFileReader(source.path, bundledFiles),
    fallbackName: path.basename(source.path),
  })
  for (const file of [...bundledFiles.keys()]) {
    if (!inspection.bundledFiles.includes(file)) bundledFiles.delete(file)
  }
  return {
    raw,
    inspection,
    bundledFiles,
    skippedFiles: files.filter(file => file !== skillFile && !bundledFiles.has(file)),
    sourceName: path.basename(source.path),
    contentSha256: packageSha256(raw, bundledFiles),
  }
}
