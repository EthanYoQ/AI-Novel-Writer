import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app, ipcMain } from 'electron'
import type { AppPromptLoadReceipt, AppPromptTemplate } from '../../src/shared/ipc-channels'
import type { WritingLanguage } from '../../src/shared/writing-language'
import {
  inspectWritingSkillMarkdown,
  parseGitHubWritingSkillUrl,
  type InstalledWritingSkill,
  type RemoteWritingSkillInspection,
} from '../../src/shared/writing-skills'
import { mainText } from '../i18n'
import { VELA_HOME, writeJsonFile } from '../utils/config-utils'

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

const WRITING_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_WRITING_SKILL_BYTES = 64 * 1024

function writingSkillDirectory(name: string): string {
  if (!WRITING_SKILL_NAME.test(name) || name === '.' || name === '..') {
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
    if (typeof repository.default_branch !== 'string' || !WRITING_SKILL_NAME.test(repository.default_branch)) {
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
 * ~/.vela 的提示词和用户 Skill 只能由此固定根目录控制器访问；渲染层不接收
 * 任意 app-data 路径，也不借用外部文件授权。
 */
export function registerAppDataController(): void {
  const inspectedWritingSkills = new Map<string, Pick<RemoteWritingSkillInspection, 'contentSha256' | 'resolvedUrl'>>()
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
    const skills: Array<{ name: string; content: string; baseDir: string; filePath: string }> = []
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
      const { filePath } = ensureOwnedSkillTarget(inspection.metadata.name)
      fs.writeFileSync(filePath, raw, { encoding: 'utf8', mode: 0o600 })
      const skill: InstalledWritingSkill = {
        name: inspection.metadata.name,
        source: 'user',
        version: inspection.metadata.version,
        language: inspection.metadata.language,
        compatible: true,
        utf8Bytes: inspection.utf8Bytes,
      }
      return { success: true, skill }
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
