import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useProjectStore } from '../../stores/project-store'
import { registerEditorExitSaveHandler, useEditorStore } from '../../stores/editor-store'
import { routeModelId } from '../../services/model-routing'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import type { NovelConfig, ProjectData } from '../../shared/ipc-channels'
import { resolveWritingLanguage } from '../../shared/writing-language'
import type { GeneratableField } from '../../services/workflows/commands/generate-field.command'
import { randomUUID } from '../../utils/id'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'
import type { SaveOutcome } from './save-feedback'
import { displayedErrorMessage } from '../../i18n/app-errors'

/** 正在写盘的设定保存，按作品会话记：设定页随切标签重挂，实例 state 会丢，在途的保存要跨重挂认得出，不能再发一次。 */
const useSavesInFlight = create<Record<string, boolean>>(() => ({}))

export const NOVEL_GENRES = ['玄幻', '仙侠', '都市', '科幻', '历史', '军事', '游戏', '末世', '悬疑', '灵异', '言情', '古言', '现言', '奇幻', '武侠', '轻小说', '同人', '职场']

/** 同路径项目重新打开时用新的 key 重挂载表单，避免旧会话的保存、生成状态泄漏到新 lease。 */
export function novelConfigSessionKey(currentProject: ProjectData | null, projectKey: string): string {
  const projectSession = captureProjectSession(currentProject)
  return projectSession && isProjectSessionPath(projectSession, projectKey)
    ? `${projectSession.projectId}:${projectSession.leaseId}`
    : `inactive:${projectKey}`
}

/**
 * 小说配置表单的数据逻辑：读写 project-store 里的配置、保存到磁盘、退出前保存、单字段与整体 AI 填充。
 * 设定页用它；调用方按 novelConfigSessionKey 挂载。
 */
export function useNovelConfigForm(projectKey: string) {
  const currentProject = useProjectStore(s => s.currentProject)
  const updateNovelConfig = useProjectStore(s => s.updateNovelConfig)
  const saveProject = useProjectStore(s => s.saveProject)
  // addLog 用 getState() 命令式调用，不订阅 workflow store，避免流式生成时高频更新导致表单重渲染。
  const addLog = useWorkflowStore.getState().addLog
  const sessionKey = novelConfigSessionKey(currentProject, projectKey)
  const saving = useSavesInFlight(s => s[sessionKey] === true)
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome>('idle')
  const [showGenerateConfig, setShowGenerateConfig] = useState(false)
  const text = useLocaleStore(s => s.text)
  const [generateSession, setGenerateSession] = useState<ReturnType<typeof captureProjectSession>>(null)
  const [generatingField, setGeneratingField] = useState<GeneratableField | null>(null)
  const [generateError, setGenerateError] = useState<{ field: GeneratableField; message: string } | null>(null)

  const projectMatches = currentProject?.path === projectKey
  const config = projectMatches ? currentProject.novelConfig : null
  const dirty = useEditorStore(state => state.tabs.some(
    tab => tab.type === 'config' && tab.projectKey === projectKey && tab.dirty,
  ))
  const exitSaveRef = useRef<(propagateFailure?: boolean) => Promise<boolean>>(async () => false)
  useEffect(() => {
    registerEditorExitSaveHandler({
      type: 'config',
      projectKey,
      save: async () => { await exitSaveRef.current(true) },
    })
  }, [projectKey])

  const update = <K extends keyof NovelConfig>(key: K, value: NovelConfig[K]) => {
    if (!config) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    updateNovelConfig({ [key]: value }, projectSession)
    setSaveOutcome('idle')
    setGenerateError(error => (error?.field === key ? null : error))
  }

  /** Store 已是最新数据，这里只持久化到磁盘。返回是否写进了这次打开的作品：没发出、作品已切换或写入失败都是 false。 */
  const save = async (propagateFailure = false): Promise<boolean> => {
    const projectSession = captureProjectSession(currentProject)
    if (!config || useSavesInFlight.getState()[sessionKey] || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return false
    useSavesInFlight.setState({ [sessionKey]: true })
    setSaveOutcome('idle')
    try {
      const saved = await saveProject(projectSession)
      if (!isProjectSessionCurrent(projectSession)) return false
      if (!saved) throw new Error(text('项目配置未能写入磁盘', 'The project configuration could not be written to disk.'))
      addLog('info', text('小说配置已保存', 'Novel configuration saved'))
      const stillDirty = useEditorStore.getState().tabs.some(
        tab => tab.type === 'config' && tab.projectKey === projectKey && tab.dirty,
      )
      setSaveOutcome(stillDirty ? 'idle' : 'saved')
      return true
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) {
        setSaveOutcome('failed')
        console.error('[NovelConfigEditor] 保存失败:', error)
        const reason = displayedErrorMessage(useLocaleStore.getState().locale, error)
        addLog('error', text(`保存失败：${reason}`, `Save failed: ${reason}`))
      }
      if (propagateFailure) throw error
      return false
    } finally {
      useSavesInFlight.setState({ [sessionKey]: false })
    }
  }
  useEffect(() => {
    exitSaveRef.current = save
  })

  const openGenerateDialog = () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!routeModelId('generate-global-config')) {
      addLog('error', text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
      return
    }
    setGenerateSession(projectSession)
    setShowGenerateConfig(true)
  }

  const generateField = async (fieldKey: GeneratableField) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!routeModelId(`generate-field:${fieldKey}`)) {
      addLog('error', text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
      return
    }
    if (generatingField) return

    setGeneratingField(fieldKey)
    setGenerateError(null)
    try {
      const { GenerateFieldCommand } = await import('../../services/workflows/commands/generate-field.command')
      if (!isProjectSessionCurrent(projectSession)) return
      const cmd = new GenerateFieldCommand(fieldKey)
      await cmd.execute({
        step: { id: '', commandId: '', name: '', params: {} },
        context: {
          runId: `config-field:${randomUUID()}`,
          projectPath: projectSession.projectPath,
          projectSession,
          writingLanguage: resolveWritingLanguage(currentProject?.novelConfig.writingLanguage),
          uiLocale: useLocaleStore.getState().locale,
          data: {},
          cancelled: false,
        },
        callbacks: {
          log: (msg: string) => useWorkflowStore.getState().addLog('info', msg),
          setProgress: () => { },
          appendText: () => { },
        },
      })
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      const draftChanged = e instanceof Error && e.message === 'GENERATION_AUTHOR_DRAFT_CHANGED'
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, e)
      addLog('error', draftChanged
        ? text(
          '生成期间小说配置已修改。已保留你的修改，请按当前配置重新生成。',
          'The novel configuration changed during generation. Your edits have been preserved. Generate again using the current configuration.',
        )
        : text(`生成失败：${reason}`, `Generation failed: ${reason}`))
      setGenerateError({ field: fieldKey, message: draftChanged
        ? text('生成期间设定改过了，已保留你的修改，请再生成一次', 'The setup changed while generating. Your edits are kept; generate again')
        : reason.replace(/[。.]\s*$/, '') })
    } finally {
      if (isProjectSessionCurrent(projectSession)) setGeneratingField(null)
    }
  }

  /** AI 填充的结果只提交给启动时冻结的会话；作品已切换或重新打开时丢弃。 */
  const applyGeneratedTo = (session: ReturnType<typeof captureProjectSession>) => (parsed: Partial<NovelConfig>) => {
    if (!isProjectSessionCurrent(session)) return
    updateNovelConfig(parsed, session)
  }

  const generateDialog = {
    isOpen: showGenerateConfig,
    onClose: () => {
      setGenerateSession(null)
      setShowGenerateConfig(false)
    },
    onGenerated: applyGeneratedTo(generateSession),
  }

  return {
    config,
    projectMatches,
    dirty,
    saving,
    saveOutcome,
    update,
    save,
    generatingField,
    generateError,
    generateField,
    openGenerateDialog,
    generateDialog,
    applyGeneratedTo,
  }
}
