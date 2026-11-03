import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { app, ipcMain } from 'electron'
import { showOpenDialogInLastDirectory } from '../utils/remembered-dialog'
import type { AppPromptLoadReceipt, AppPromptTemplate } from '../../src/shared/ipc-channels'
import type { WritingLanguage } from '../../src/shared/writing-language'
import {
  inspectWritingSkillMarkdown,
  MAX_WRITING_SKILL_BYTES,
  parseGitHubWritingSkillUrl,
  WRITING_SKILL_NAME_PATTERN,
  type InstalledWritingSkill,
  type InstalledWritingSkillBundle,
  type LocalWritingSkillInspection,
  type LocalWritingSkillSourceKind,
  type RemoteWritingSkillInspection,
  type WritingSkillBundledFile,
  type WritingSkillInspection,
  type WritingSkillPackageInspection,
} from '../../src/shared/writing-skills'
import { mainText } from '../i18n'
import { VELA_HOME, writeJsonFile } from '../utils/config-utils'
import { assertGlobalDataReady } from '../services/app-data-locator'
import {
  loadLocalWritingSkill,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_ENTRIES,
  readInstalledSkillFile,
  readInstalledWritingSkillBundle,
  WRITING_SKILL_BUNDLE_MANIFEST,
  writingSkillBundleManifest,
  WritingSkillPackageError,
  type WritingSkillPackageErrorCode,
  type WritingSkillSource,
} from '../services/writing-skill-package'

type SkillEvent = { sender: { id: number; isDestroyed: () => boolean } }

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return !(
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  )
}

function promptKeyPath(key: string, writingLanguage?: WritingLanguage): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)
    || key === '.'
    || key === '..'
  ) {
    throw new Error(text('提示词标识无效', 'The prompt identifier is invalid'))
  }
  const promptsDirectory = path.join(VELA_HOME, 'prompts')
  const suffix = writingLanguage ? `.${writingLanguage}` : ''
  const candidatePath = path.resolve(promptsDirectory, `${key}${suffix}.json`)
  if (!isContainedPath(promptsDirectory, candidatePath)) {
    throw new Error(text('提示词目标超出应用目录', 'The prompt target is outside the app directory'))
  }
  return candidatePath
}

function isPromptTemplate(value: unknown): value is AppPromptTemplate {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as AppPromptTemplate).key === 'string'
    && (
      (value as AppPromptTemplate).writingLanguage === undefined
      || (value as AppPromptTemplate).writingLanguage === 'zh-CN'
      || (value as AppPromptTemplate).writingLanguage === 'en-US'
    )
}

function validSender(event: SkillEvent): boolean {
  return Boolean(event?.sender && Number.isSafeInteger(event.sender.id) && event.sender.id > 0
    && typeof event.sender.isDestroyed === 'function' && !event.sender.isDestroyed())
}

function writingSkillDirectory(name: string): string {
  if (!WRITING_SKILL_NAME_PATTERN.test(name) || name === '.' || name === '..') {
    throw new Error(text('写作 Skill 名称无效', 'The writing skill name is invalid'))
  }
  const root = path.join(VELA_HOME, 'skills')
  const candidate = path.resolve(root, name)
  if (!isContainedPath(root, candidate)) {
    throw new Error(text('写作 Skill 目标超出应用目录', 'The writing skill target is outside the app directory'))
  }
  return candidate
}

function ensureOwnedSkillsRoot(): string {
  assertGlobalDataReady()
  if (fs.existsSync(VELA_HOME)) {
    const homeInfo = fs.lstatSync(VELA_HOME)
    if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) {
      throw new Error(text('应用数据目录不是受信任的本地目录', 'The app data root is not a trusted local directory'))
    }
  } else {
    fs.mkdirSync(VELA_HOME, { recursive: true })
  }
  const canonicalVelaHome = fs.realpathSync.native(VELA_HOME)
  const skillsRoot = path.join(VELA_HOME, 'skills')
  if (fs.existsSync(skillsRoot)) {
    const rootInfo = fs.lstatSync(skillsRoot)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error(text('用户 Skill 目录不是受信任的本地目录', 'The user skill root is not a trusted local directory'))
    }
  } else {
    fs.mkdirSync(skillsRoot)
  }
  const canonicalRoot = fs.realpathSync.native(skillsRoot)
  if (!isContainedPath(canonicalVelaHome, canonicalRoot)) {
    throw new Error(text('用户 Skill 目录超出应用目录', 'The user skill root is outside the app directory'))
  }
  return canonicalRoot
}

function ensureOwnedSkillTarget(name: string): { directory: string; filePath: string } {
  const canonicalRoot = ensureOwnedSkillsRoot()
  const requestedDirectory = writingSkillDirectory(name)
  if (fs.existsSync(requestedDirectory)) {
    const directoryInfo = fs.lstatSync(requestedDirectory)
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error(text('拒绝写入链接或非目录 Skill 目标', 'Refusing to write to a linked or non-directory skill target'))
    }
  } else {
    fs.mkdirSync(requestedDirectory)
  }
  const directory = fs.realpathSync.native(requestedDirectory)
  if (!isContainedPath(canonicalRoot, directory)) {
    throw new Error(text('写作 Skill 目标超出应用目录', 'The writing skill target is outside the app directory'))
  }
  const filePath = path.join(directory, 'SKILL.md')
  if (fs.existsSync(filePath)) {
    const fileInfo = fs.lstatSync(filePath)
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
      throw new Error(text('拒绝覆盖链接或非文件 SKILL.md', 'Refusing to overwrite a linked or non-file SKILL.md'))
    }
    const canonicalFile = fs.realpathSync.native(filePath)
    if (!isContainedPath(directory, canonicalFile)) {
      throw new Error(text('SKILL.md 超出 Skill 目录', 'SKILL.md is outside its skill directory'))
    }
  }
  return { directory, filePath }
}

function packageErrorText(code: WritingSkillPackageErrorCode): string {
  const copy: Record<WritingSkillPackageErrorCode, readonly [string, string]> = {
    SOURCE_INVALID: ['无法读取所选的文件或文件夹', 'The selected file or folder cannot be read'],
    SYMLINK: ['Skill 中包含符号链接或快捷方式，已拒绝导入', 'The skill contains a symbolic link or junction and was rejected'],
    SKILL_MD_MISSING: ['文件夹根目录里没有 SKILL.md', 'The folder has no SKILL.md at its root'],
    SKILL_MD_INVALID: ['SKILL.md 必须是不超过 64 KiB 的 UTF-8 文本', 'SKILL.md must be UTF-8 text no larger than 64 KiB'],
    FOLDER_TOO_LARGE: [
      `文件夹内文件过多或层级过深（最多 ${MAX_FOLDER_ENTRIES} 项、${MAX_FOLDER_DEPTH} 层）`,
      `The folder has too many entries or levels (up to ${MAX_FOLDER_ENTRIES} entries, ${MAX_FOLDER_DEPTH} levels)`,
    ],
  }
  return text(copy[code][0], copy[code][1])
}

function loadLocalSkillOrThrow(source: WritingSkillSource) {
  let loaded: ReturnType<typeof loadLocalWritingSkill>
  try {
    loaded = loadLocalWritingSkill(source)
  } catch (error) {
    if (error instanceof WritingSkillPackageError) throw new Error(packageErrorText(error.code))
    // 读盘时的系统错误（EACCES 等）带本机路径，界面只给可读说明，原文留在日志里。
    console.error('[skills] reading a local writing skill failed', error)
    throw new Error(packageErrorText('SOURCE_INVALID'))
  }
  const { name } = loaded.inspection.metadata
  if (!WRITING_SKILL_NAME_PATTERN.test(name)) {
    throw new Error(text(
      `Skill 名称“${name}”无效：只能使用字母、数字、点、下划线和连字符`,
      `The skill name "${name}" is invalid: use letters, digits, dots, underscores, and hyphens`,
    ))
  }
  return loaded
}

/**
 * 把已确认的候选写入全局用户 Skill 库。GitHub 导入只写 SKILL.md（bundle 为 undefined，与旧版一致）；
 * 本机导入另写并入的附带文件和安装清单，清单为空也写，列表与生成据此只读清单里的文件。
 */
function installUserWritingSkill(
  inspection: Pick<WritingSkillInspection, 'metadata' | 'compatible' | 'reasons' | 'utf8Bytes'>,
  raw: string,
  bundle?: readonly WritingSkillBundledFile[],
): InstalledWritingSkill {
  if (!inspection.compatible) {
    throw new Error(text(
      `该 Skill 不是自包含提示词：${inspection.reasons.join(', ')}`,
      `This is not a self-contained prompt skill: ${inspection.reasons.join(', ')}`,
    ))
  }
  const requestedDirectory = writingSkillDirectory(inspection.metadata.name)
  if (fs.existsSync(requestedDirectory)) {
    throw new Error(text(
      `同名 Writing Skill 已安装：${inspection.metadata.name}`,
      `A Writing Skill with this name is already installed: ${inspection.metadata.name}`,
    ))
  }
  const { directory, filePath } = ensureOwnedSkillTarget(inspection.metadata.name)
  try {
    // 清单先写：安装中途崩溃时目录被判为「已损坏」而不是按旧规则「兼容」却缺了附带内容。
    if (bundle) {
      fs.writeFileSync(path.join(directory, WRITING_SKILL_BUNDLE_MANIFEST), writingSkillBundleManifest(bundle), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    }
    fs.writeFileSync(filePath, raw, { encoding: 'utf8', mode: 0o600 })
    for (const { path: relativePath, content } of bundle ?? []) {
      const target = path.resolve(directory, ...relativePath.split('/'))
      if (!isContainedPath(directory, target) || target === directory) {
        throw new Error(text('附带文件超出 Skill 目录', 'A bundled file is outside its skill directory'))
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    }
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true })
    // 文件系统错误（EEXIST、EACCES、ENOSPC 等）带本机路径，界面只给可读说明，原文留在日志里。
    if (typeof (error as NodeJS.ErrnoException)?.code !== 'string') throw error
    console.error('[skills] writing skill install failed', error)
    throw new Error(text(
      '写入 Skill 文件失败，本次没有安装任何内容。请重新选择或检查该 Skill 后再试。',
      'The skill files could not be written, so nothing was installed. Choose or inspect the skill again to retry.',
    ))
  }
  return {
    name: inspection.metadata.name,
    source: 'user',
    version: inspection.metadata.version,
    language: inspection.metadata.language,
    compatible: true,
    utf8Bytes: inspection.utf8Bytes,
  }
}

/** 回给渲染层的检查结果不带提示词正文，安装时以主进程重新读取的内容为准。 */
function withoutContent(inspection: WritingSkillPackageInspection): Omit<WritingSkillPackageInspection, 'content'> {
  const { metadata, compatible, reasons, suggestedStage, utf8Bytes, bundledFiles, unbundledReferences } = inspection
  return { metadata, compatible, reasons, suggestedStage, utf8Bytes, bundledFiles, unbundledReferences }
}

function githubRawUrl(owner: string, repo: string, ref: string, filePath: string): string {
  const segments = [owner, repo, ref, ...filePath.split('/')].map(encodeURIComponent)
  return `https://raw.githubusercontent.com/${segments.join('/')}`
}

async function fetchGitHubWritingSkill(sourceUrl: string): Promise<{
  raw: string
  inspection: RemoteWritingSkillInspection
}> {
  const location = parseGitHubWritingSkillUrl(sourceUrl)
  let ref = location.ref
  if (!ref) {
    const repositoryResponse = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AI-Novel-Writer' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!repositoryResponse.ok) throw new Error(`GitHub repository lookup failed (${repositoryResponse.status})`)
    const repository = await repositoryResponse.json() as { default_branch?: unknown }
    if (typeof repository.default_branch !== 'string' || !WRITING_SKILL_NAME_PATTERN.test(repository.default_branch)) {
      throw new Error('GitHub returned an unsupported default branch name')
    }
    ref = repository.default_branch
  }

  const resolvedUrl = githubRawUrl(location.owner, location.repo, ref, location.path)
  const response = await fetch(resolvedUrl, {
    headers: { Accept: 'text/plain', 'User-Agent': 'AI-Novel-Writer' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`SKILL.md download failed (${response.status})`)
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_WRITING_SKILL_BYTES) throw new Error('SKILL.md is larger than 64 KiB')
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_WRITING_SKILL_BYTES) {
    throw new Error('SKILL.md is larger than 64 KiB')
  }
  const inspected = inspectWritingSkillMarkdown(raw)
  const contentSha256 = createHash('sha256').update(raw, 'utf8').digest('hex')
  const publicInspection = {
    metadata: inspected.metadata,
    compatible: inspected.compatible,
    reasons: inspected.reasons,
    suggestedStage: inspected.suggestedStage,
    utf8Bytes: inspected.utf8Bytes,
  }
  return {
    raw,
    inspection: {
      ...publicInspection,
      sourceUrl,
      resolvedUrl,
      contentSha256,
    },
  }
}

function promptFilename(template: AppPromptTemplate): string {
  return `${template.key}${template.writingLanguage ? `.${template.writingLanguage}` : ''}`
}

function promptKeyFromFilename(filename: string): string {
  return path.basename(filename, '.json').replace(/\.(?:zh-CN|en-US)$/u, '')
}

function promptLanguageFromFilename(filename: string): WritingLanguage | undefined {
  const match = filename.match(/\.(zh-CN|en-US)\.json$/u)
  return match?.[1] as WritingLanguage | undefined
}

/**
 * 已准入全局 generation 的提示词和用户 Skill 只能由此固定根目录控制器访问；渲染层不接收
 * 任意 app-data 路径，也不借用外部文件授权。
 */
export function registerAppDataController(): void {
  assertGlobalDataReady()
  const inspectedWritingSkills = new Map<string, Pick<RemoteWritingSkillInspection, 'contentSha256' | 'resolvedUrl'>>()
  // 每个渲染进程最多保留一个待安装的本机候选，新的选择会替换旧的。
  const localCandidates = new Map<number, { candidateId: string; source: WritingSkillSource; contentSha256: string }>()
  ipcMain.handle('prompt:load-global', async (): Promise<AppPromptLoadReceipt> => {
    const promptsDirectory = path.join(VELA_HOME, 'prompts')
    if (!fs.existsSync(promptsDirectory)) return { templates: [], diagnostics: [] }

    const prompts: AppPromptTemplate[] = []
    const diagnostics: AppPromptLoadReceipt['diagnostics'] = []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(promptsDirectory, { withFileTypes: true })
    } catch (error) {
      return {
        templates: [],
        diagnostics: [{
          path: 'prompts',
          error: error instanceof Error ? error.message : String(error),
        }],
      }
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const candidatePath = path.join(promptsDirectory, entry.name)
        const canonicalPath = fs.realpathSync.native(candidatePath)
        if (!isContainedPath(fs.realpathSync.native(promptsDirectory), canonicalPath)) continue
        const parsed = JSON.parse(fs.readFileSync(canonicalPath, 'utf8')) as unknown
        if (!isPromptTemplate(parsed)) {
          throw new Error(text('提示词内容结构无效', 'The prompt content shape is invalid'))
        }
        const filenameKey = path.basename(entry.name, '.json')
        if (promptFilename(parsed) !== filenameKey) {
          throw new Error(text('提示词标识或语言与文件名不一致', 'The prompt identifier or language does not match its filename'))
        }
        prompts.push(parsed)
      } catch (error) {
        diagnostics.push({
          key: promptKeyFromFilename(entry.name),
          ...(promptLanguageFromFilename(entry.name)
            ? { writingLanguage: promptLanguageFromFilename(entry.name) }
            : {}),
          path: entry.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { templates: prompts, diagnostics }
  })

  ipcMain.handle('prompt:save-global', async (_event, template: AppPromptTemplate) => {
    try {
      if (!isPromptTemplate(template)) {
        throw new Error(text('提示词内容无效', 'The prompt content is invalid'))
      }
      const writingLanguage = template.writingLanguage ?? 'zh-CN'
      writeJsonFile(promptKeyPath(template.key, writingLanguage), { ...template, writingLanguage })
      if (writingLanguage === 'zh-CN') {
        const legacyPath = promptKeyPath(template.key)
        if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('prompt:delete-global', async (_event, key: string, writingLanguage: WritingLanguage) => {
    try {
      const filePaths = [promptKeyPath(key, writingLanguage)]
      if (writingLanguage === 'zh-CN') filePaths.push(promptKeyPath(key))
      for (const filePath of filePaths) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('skills:list-user', async () => {
    const skillsDirectory = path.join(VELA_HOME, 'skills')
    if (!fs.existsSync(skillsDirectory)) return []

    const canonicalSkillsDirectory = ensureOwnedSkillsRoot()
    const skills: Array<{ name: string; content: string; baseDir: string; filePath: string; bundle: InstalledWritingSkillBundle }> = []
    for (const entry of fs.readdirSync(canonicalSkillsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      try {
        const baseDir = fs.realpathSync.native(path.join(canonicalSkillsDirectory, entry.name))
        if (!isContainedPath(canonicalSkillsDirectory, baseDir)) continue
        const filePath = fs.realpathSync.native(path.join(baseDir, 'SKILL.md'))
        if (!isContainedPath(baseDir, filePath) || !fs.statSync(filePath).isFile()) continue
        skills.push({
          name: entry.name,
          content: fs.readFileSync(filePath, 'utf8'),
          baseDir,
          filePath,
          // 与生成来源绑定共用同一条读取与判定：没有清单只看 SKILL.md，有清单只读清单里的文件。
          bundle: readInstalledWritingSkillBundle(relativePath => readInstalledSkillFile(baseDir, relativePath)),
        })
      } catch {
        // 单个用户 Skill 无效时不阻断其余 Skill。
      }
    }
    return skills
  })

  ipcMain.handle('skills:inspect-github', async (_event, sourceUrl: string) => {
    try {
      if (typeof sourceUrl !== 'string' || sourceUrl.length > 2_048) {
        throw new Error(text('GitHub 地址无效', 'The GitHub URL is invalid'))
      }
      const { inspection } = await fetchGitHubWritingSkill(sourceUrl)
      inspectedWritingSkills.set(sourceUrl, {
        contentSha256: inspection.contentSha256,
        resolvedUrl: inspection.resolvedUrl,
      })
      return { success: true, inspection }
    } catch (error) {
      if (typeof sourceUrl === 'string') inspectedWritingSkills.delete(sourceUrl)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:install-github', async (_event, sourceUrl: string) => {
    try {
      if (typeof sourceUrl !== 'string' || sourceUrl.length > 2_048) {
        throw new Error(text('GitHub 地址无效', 'The GitHub URL is invalid'))
      }
      const confirmedInspection = inspectedWritingSkills.get(sourceUrl)
      if (!confirmedInspection) {
        throw new Error(text(
          '请先检查该 GitHub Writing Skill，再确认安装',
          'Inspect this GitHub Writing Skill before confirming installation',
        ))
      }
      inspectedWritingSkills.delete(sourceUrl)
      // Refetch after confirmation. Renderer-provided inspection data is never trusted as install input.
      const { raw, inspection } = await fetchGitHubWritingSkill(sourceUrl)
      if (
        inspection.contentSha256 !== confirmedInspection.contentSha256
        || inspection.resolvedUrl !== confirmedInspection.resolvedUrl
      ) {
        throw new Error(text(
          'Writing Skill 在检查后已发生变化，请重新检查',
          'The Writing Skill changed after inspection; inspect it again',
        ))
      }
      return { success: true, skill: installUserWritingSkill(inspection, raw) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:pick-local', async (event: SkillEvent, kind: LocalWritingSkillSourceKind) => {
    try {
      if (!validSender(event)) throw new Error(text('请求来源无效', 'The request sender is invalid'))
      if (kind !== 'file' && kind !== 'folder') throw new Error(text('导入方式无效', 'The import kind is invalid'))
      const selection = await showOpenDialogInLastDirectory('writing-skill', kind === 'folder'
        ? { title: text('选择 Skill 文件夹', 'Choose a skill folder'), properties: ['openDirectory'] }
        : {
            title: text('选择 SKILL.md 文件', 'Choose a SKILL.md file'),
            properties: ['openFile'],
            filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
          })
      if (selection.canceled || selection.filePaths.length === 0) return { success: true, cancelled: true }
      localCandidates.delete(event.sender.id)
      if (selection.filePaths.length !== 1) throw new Error(text('请只选择一项', 'Choose exactly one item'))
      const source = { kind, path: selection.filePaths[0] }
      const loaded = loadLocalSkillOrThrow(source)
      const candidateId = randomUUID()
      localCandidates.set(event.sender.id, { candidateId, source, contentSha256: loaded.contentSha256 })
      const inspection: LocalWritingSkillInspection = {
        ...withoutContent(loaded.inspection),
        candidateId,
        sourceKind: kind,
        sourceName: loaded.sourceName,
        contentSha256: loaded.contentSha256,
        skippedFiles: loaded.skippedFiles,
      }
      return { success: true, cancelled: false, inspection }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:install-local', async (event: SkillEvent, candidateId: string) => {
    try {
      if (!validSender(event)) throw new Error(text('请求来源无效', 'The request sender is invalid'))
      const pending = localCandidates.get(event.sender.id)
      if (!pending || pending.candidateId !== candidateId) {
        throw new Error(text(
          '请先检查该本机 Writing Skill，再确认安装',
          'Inspect this local Writing Skill before confirming installation',
        ))
      }
      localCandidates.delete(event.sender.id)
      // 确认后重新读盘，只安装与检查时逐字节相同的内容。
      const loaded = loadLocalSkillOrThrow(pending.source)
      if (loaded.contentSha256 !== pending.contentSha256) {
        throw new Error(text(
          'Writing Skill 在检查后已发生变化，请重新检查',
          'The Writing Skill changed after inspection; inspect it again',
        ))
      }
      return { success: true, skill: installUserWritingSkill(loaded.inspection, loaded.raw, loaded.bundledFiles) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:uninstall-user', async (_event, name: string) => {
    try {
      const directory = writingSkillDirectory(name)
      const skillsRoot = path.join(VELA_HOME, 'skills')
      if (!fs.existsSync(skillsRoot)) return { success: true }
      const canonicalRoot = ensureOwnedSkillsRoot()
      if (!fs.existsSync(directory)) return { success: true }
      if (fs.lstatSync(directory).isSymbolicLink()) {
        throw new Error(text('拒绝删除符号链接 Skill', 'Refusing to delete a symlinked skill'))
      }
      const canonicalDirectory = fs.realpathSync.native(directory)
      if (!isContainedPath(canonicalRoot, canonicalDirectory)) {
        throw new Error(text('写作 Skill 目标超出应用目录', 'The writing skill target is outside the app directory'))
      }
      fs.rmSync(canonicalDirectory, { recursive: true, force: false })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
