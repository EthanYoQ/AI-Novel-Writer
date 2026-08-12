import fs from 'node:fs'
import path from 'node:path'
import { app, ipcMain } from 'electron'
import type { AppPromptLoadReceipt, AppPromptTemplate } from '../../src/shared/ipc-channels'
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

function promptKeyPath(key: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)
    || key === '.'
    || key === '..'
  ) {
    throw new Error(text('提示词标识无效', 'The prompt identifier is invalid'))
  }
  const promptsDirectory = path.join(VELA_HOME, 'prompts')
  const candidatePath = path.resolve(promptsDirectory, `${key}.json`)
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
}

/**
 * ~/.vela 的提示词和用户 Skill 只能由此固定根目录控制器访问；渲染层不接收
 * 任意 app-data 路径，也不借用外部文件授权。
 */
export function registerAppDataController(): void {
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
        if (parsed.key !== filenameKey) {
          throw new Error(text('提示词标识与文件名不一致', 'The prompt identifier does not match its filename'))
        }
        prompts.push(parsed)
      } catch (error) {
        diagnostics.push({
          key: path.basename(entry.name, '.json'),
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
      writeJsonFile(promptKeyPath(template.key), template)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('prompt:delete-global', async (_event, key: string) => {
    try {
      const filePath = promptKeyPath(key)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('skills:list-user', async () => {
    const skillsDirectory = path.join(VELA_HOME, 'skills')
    if (!fs.existsSync(skillsDirectory)) return []

    const canonicalSkillsDirectory = fs.realpathSync.native(skillsDirectory)
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
}
