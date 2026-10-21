import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  inspectLocalWritingSkill,
  MAX_WRITING_SKILL_BUNDLED_FILES,
  MAX_WRITING_SKILL_BYTES,
  WRITING_SKILL_TEXT_EXTENSIONS,
  type InstalledWritingSkillBundle,
  type LocalWritingSkillSourceKind,
  type WritingSkillBundledFile,
  type WritingSkillPackageInspection,
} from '../../src/shared/writing-skills'

export const MAX_FOLDER_ENTRIES = 200
export const MAX_FOLDER_DEPTH = 4

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
  inspection: WritingSkillPackageInspection
  /** 并入提示词的附带文件原文，顺序与 inspection.bundledFiles 相同；安装时原样写盘并记入清单。 */
  bundledFiles: WritingSkillBundledFile[]
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

/** 按刚选中的 Skill 文件夹读取附带文本。逐段 lstat，路径上任何一段是链接或不是目录都视为不存在。 */
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

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function packageSha256(raw: string, bundledFiles: readonly WritingSkillBundledFile[]): string {
  return sha256(Buffer.from(JSON.stringify([raw, ...bundledFiles]), 'utf8'))
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

  if (source.kind === 'file') {
    if (!info.isFile() || !/\.(?:md|markdown)$/i.test(source.path)) throw new WritingSkillPackageError('SOURCE_INVALID')
    const raw = readTextFile(source.path)
    if (raw === undefined) throw new WritingSkillPackageError('SKILL_MD_INVALID')
    const inspection = inspectLocalWritingSkill(raw, { fallbackName: fileFallbackName(source.path) })
    return {
      raw,
      inspection,
      bundledFiles: [],
      skippedFiles: [],
      sourceName: path.basename(source.path),
      contentSha256: packageSha256(raw, []),
    }
  }

  if (!info.isDirectory()) throw new WritingSkillPackageError('SOURCE_INVALID')
  const files = listFolderFiles(source.path)
  const skillFile = files.find(file => file.toLowerCase() === 'skill.md')
  if (!skillFile) throw new WritingSkillPackageError('SKILL_MD_MISSING')
  const raw = readTextFile(path.join(source.path, skillFile))
  if (raw === undefined) throw new WritingSkillPackageError('SKILL_MD_INVALID')
  const read = new Map<string, string>()
  const inspection = inspectLocalWritingSkill(raw, {
    readFile: skillDirectoryFileReader(source.path, read),
    fallbackName: path.basename(source.path),
  })
  const bundledFiles = inspection.bundledFiles.map(file => ({ path: file, content: read.get(file)! }))
  // 引用写法与磁盘上的大小写可以不同（`](Forms.md)` 读到 forms.md），比对时不分大小写。
  const bundledLower = new Set(inspection.bundledFiles.map(file => file.toLowerCase()))
  return {
    raw,
    inspection,
    bundledFiles,
    skippedFiles: files.filter(file => file !== skillFile && !bundledLower.has(file.toLowerCase())),
    sourceName: path.basename(source.path),
    contentSha256: packageSha256(raw, bundledFiles),
  }
}

/** 本机导入写进 Skill 目录的安装清单。以点开头，再次从这个目录导入时会被忽略。 */
export const WRITING_SKILL_BUNDLE_MANIFEST = '.pagekin-bundle.json'

/** 清单记录并入文件的相对路径（按引用顺序）与安装时写下的 UTF-8 字节的 SHA-256。 */
export function writingSkillBundleManifest(files: readonly WritingSkillBundledFile[]): string {
  const entries = files.map(file => ({ path: file.path, sha256: sha256(Buffer.from(file.content, 'utf8')) }))
  return `${JSON.stringify({ version: 1, files: entries }, null, 2)}\n`
}

const MANIFEST_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/

/** 清单来自磁盘，按不可信输入解析；任何一项不合规都返回 null。 */
function parseBundleManifest(bytes: Buffer): Array<{ path: string; sha256: string }> | null {
  let manifest: unknown
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!manifest || typeof manifest !== 'object' || (manifest as { version?: unknown }).version !== 1) return null
  const files = (manifest as { files?: unknown }).files
  if (!Array.isArray(files) || files.length > MAX_WRITING_SKILL_BUNDLED_FILES) return null
  const seen = new Set(['skill.md'])
  const entries: Array<{ path: string; sha256: string }> = []
  for (const entry of files) {
    const { path: relative, sha256: digest } = (entry ?? {}) as { path?: unknown; sha256?: unknown }
    if (typeof relative !== 'string' || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return null
    if (!MANIFEST_PATH.test(relative) || relative.split('/').some(part => part === '.' || part === '..')) return null
    if (!WRITING_SKILL_TEXT_EXTENSIONS.some(extension => relative.toLowerCase().endsWith(extension))) return null
    if (seen.has(relative.toLowerCase())) return null
    seen.add(relative.toLowerCase())
    entries.push({ path: relative, sha256: digest })
  }
  return entries
}

/**
 * 读取已安装 Skill 的附带文件：只读清单列出的文件，逐个比对哈希。
 * read 返回 null 表示文件不存在，抛错表示不安全或读不到。设置页的列表与生成来源绑定共用这一条判定。
 */
export function readInstalledWritingSkillBundle(read: (relativePath: string) => Buffer | null): InstalledWritingSkillBundle {
  const damaged: InstalledWritingSkillBundle = { status: 'damaged' }
  try {
    const manifestBytes = read(WRITING_SKILL_BUNDLE_MANIFEST)
    if (manifestBytes === null) return { status: 'none' }
    const entries = parseBundleManifest(manifestBytes)
    if (!entries) return damaged
    const files: WritingSkillBundledFile[] = []
    for (const entry of entries) {
      const bytes = read(entry.path)
      if (bytes === null || sha256(bytes) !== entry.sha256) return damaged
      files.push({ path: entry.path, content: bytes.toString('utf8') })
    }
    return { status: 'intact', files }
  } catch {
    return damaged
  }
}

/**
 * 按已安装 Skill 目录读取一个文件，规则与生成来源绑定的读取相同：
 * 路径上任何一段是链接、中间段不是目录、末段不是只有一个硬链接的普通文件，都抛错；不存在返回 null。
 */
export function readInstalledSkillFile(root: string, relativePath: string): Buffer | null {
  let cursor = root
  const segments = relativePath.split('/')
  // 不依赖调用方先校验：`.`/`..` 片段一律拒绝，读取不会越出 Skill 目录。
  if (segments.some(segment => segment === '.' || segment === '..')) throw new Error('WRITING_SKILL_FILE_UNSAFE')
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment)
    let info: fs.Stats
    try {
      info = fs.lstatSync(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const last = index === segments.length - 1
    if (info.isSymbolicLink() || (!last && !info.isDirectory()) || (last && (!info.isFile() || info.nlink !== 1))) {
      throw new Error('WRITING_SKILL_FILE_UNSAFE')
    }
  }
  return fs.readFileSync(cursor)
}
