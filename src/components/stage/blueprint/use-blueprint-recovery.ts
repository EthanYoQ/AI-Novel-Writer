import { useCallback, useEffect, useRef, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { launchCreativeWorkflow } from '../../../services/workflows/creative-workflow-launcher'
import { parseTextBlueprintsStrict } from '../../../services/workflows/directory-workflow'
import { workflowMainProcessError } from '../../../services/workflows/workflow-project-session'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { structuredContractDiagnostic, structuredContractDiagnosticText } from '../../../shared/structured-contract-diagnostic'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { registerEditorExitSaveHandler, useEditorStore, type EditorTab, type PlanningRecoverySaveSnapshot } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { currentProjectSessionForPath, isCurrentProjectSession } from '../../editor/use-chapter-blueprints'

/**
 * 蓝图恢复稿标签的数据与两项操作：保存恢复蓝图（只写本地，按冻结的提交快照重试）与继续生成缺少的章节。
 * 会话在标签挂载时冻结：作品换了或重新打开后，保存与继续都拒绝，提示作者重新打开恢复稿。
 */
export function useBlueprintRecovery(tab: EditorTab, projectKey: string) {
  const text = useLocaleStore(state => state.text)
  const locale = useLocaleStore(state => state.locale)
  const [session] = useState(() => currentProjectSessionForPath(projectKey))
  const currentProject = useProjectStore(state => state.currentProject)
  const sessionCurrent = sameProjectSessionContext(session, projectSessionContextFromProject(currentProject))
  const [context, setContext] = useState(tab.planningRecovery)
  const [end, setEndState] = useState(String(tab.planningSaveEnd ?? ''))
  const endRef = useRef(end)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const currentTab = useEditorStore(state => state.tabs.find(item => item.id === tab.id)) ?? tab
  /** 作者稿不合蓝图契约时说明哪个字段出了什么问题；主进程经 IPC 拒绝时按登记的码说明。 */
  const failureText = useCallback((reason: unknown) => {
    const shown = useLocaleStore.getState().locale
    const diagnostic = structuredContractDiagnostic(reason)
    return diagnostic ? structuredContractDiagnosticText(shown, diagnostic) : displayedErrorMessage(shown, reason)
  }, [])

  const refresh = useCallback(async () => {
    const expectedSession = session
    const original = tab.planningRecovery
    if (!expectedSession || !isCurrentProjectSession(expectedSession) || !original) throw new Error(text('项目会话已切换，请重新打开恢复稿', 'The project session changed. Reopen the recovery draft.'))
    const next = await ipc.invokeWithProjectSession(expectedSession, 'generation:read-context', { handle: original.handle })
    if (!isCurrentProjectSession(expectedSession)) throw new Error(text('项目会话已切换', 'The project session changed.'))
    setContext(next)
    return next
  }, [session, tab.planningRecovery, text])
  useEffect(() => { void Promise.resolve().then(refresh).catch(reason => setError(failureText(reason))) }, [failureText, refresh])

  const save = useCallback(async (propagate = false) => {
    if (busyRef.current) { if (propagate) throw new Error(text('保存仍在进行', 'Saving is still in progress.')); return }
    busyRef.current = true
    setBusy(true)
    const snapshot = useEditorStore.getState().tabs.find(item => item.id === tab.id)
    try {
      if (!session) throw new Error(text('项目会话已切换', 'The project session changed.'))
      const fresh = await refresh()
      const candidate = fresh.blueprintRecovery
      if (candidate?.writeState === 'unavailable') throw new Error(text('旧恢复稿不能保存或续接，可继续编辑或复制', 'This recovery draft cannot be saved or continued. You can still edit or copy it.'))
      const originalRange = tab.planningRecovery?.blueprintRecovery?.editRange
      if (!snapshot || !candidate || candidate.leaseEpoch !== session.leaseId || !originalRange || !snapshot.planningSaveOperationId
        || candidate.writeState !== 'ready' && !candidate.saved) throw new Error(text('当前无法保存，请等待生成结束或检查来源变化', 'Wait for generation to finish or check changed sources before saving.'))
      const pending = useEditorStore.getState().tabs.find(item => item.id === tab.id)?.planningSaveSnapshot
      if (pending?.status === 'saved' || candidate.saved && !pending) throw new Error(text('本次恢复已保存，后续修改仅供复制。', 'This recovery is saved. Further edits can only be copied.'))
      let submission = pending
      if (!submission) {
        const authorEnd = Number(endRef.current)
        if (!Number.isSafeInteger(authorEnd) || authorEnd < originalRange.from || authorEnd > originalRange.to) throw new Error(text('请选择连续完整章节的终点', 'Choose the last complete consecutive chapter.'))
        const blueprints = parseTextBlueprintsStrict(snapshot.content ?? '', originalRange.from, authorEnd, locale, 'author')
        submission = {
          content: snapshot.content ?? '', contentRevision: snapshot.contentRevision ?? 0,
          status: 'pending', channel: 'db:blueprint-commit-range',
          request: { mode: 'replace-range', operationId: snapshot.planningSaveOperationId,
            startChapter: originalRange.from, endChapter: authorEnd, blueprints,
            authorRecovery: { sourceHandle: candidate.sourceHandle, leaseEpoch: candidate.leaseEpoch } },
        } satisfies PlanningRecoverySaveSnapshot
        useEditorStore.getState().setPlanningSaveSnapshot(tab.id, submission)
      }
      if (submission.channel !== 'db:blueprint-commit-range') throw new Error('INVALID_PLANNING_SAVE_CHANNEL')
      const result = await ipc.invokeWithProjectSession(session, 'db:blueprint-commit-range', {
        ...submission.request, authorRecovery: { ...submission.request.authorRecovery, leaseEpoch: candidate.leaseEpoch },
      }, projectKey)
      if (!result.success && !pending && isCurrentProjectSession(session)) useEditorStore.getState().setPlanningSaveSnapshot(tab.id, undefined)
      if (!result.success) throw workflowMainProcessError({ uiLocale: useLocaleStore.getState().locale }, result.error, '保存恢复蓝图失败', 'Could not save the recovered blueprints.')
      if (!isCurrentProjectSession(session)) return
      useEditorStore.getState().setPlanningSaveSnapshot(tab.id, { ...submission, status: 'saved' })
      useEditorStore.getState().settleTabSave(tab.id, submission)
      setError('')
      await refresh()
    } catch (reason) { setError(failureText(reason)); if (propagate) throw reason }
    finally { busyRef.current = false; setBusy(false) }
  }, [failureText, locale, projectKey, refresh, session, tab.id, tab.planningRecovery, text])
  useEffect(() => {
    registerEditorExitSaveHandler({ tabId: tab.id, type: 'chapter-card', save: () => save(true) })
  }, [save, tab.id])

  const continuePlanning = async () => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      if (!session) throw new Error(text('项目会话已切换', 'The project session changed.'))
      const fresh = await refresh()
      const continuation = fresh.planningContinuation
      if (!continuation?.remainingRange || !['ready', 'continued'].includes(continuation.state)) throw new Error(text('当前不能继续，请等待生成结束或检查来源变化', 'Wait for generation to finish or check changed sources before continuing.'))
      await launchCreativeWorkflow({ workflow: 'generate_blueprint', params: { mode: 'append',
        startChapter: continuation.remainingRange.from, count: continuation.remainingRange.to - continuation.remainingRange.from + 1,
        targetUnits: continuation.targetUnits, restartFrom: continuation.sourceHandle,
      } }, session)
      await refresh()
      setError('')
    } catch (reason) { setError(failureText(reason)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  /** 保存终点随标签保留：页面卸载再挂载（切标签）后仍是作者上次选的那一章。 */
  const setEnd = (value: string) => {
    endRef.current = value
    setEndState(value)
    useEditorStore.setState(state => ({ tabs: state.tabs.map(item => item.id === tab.id ? { ...item, planningSaveEnd: value } : item) }))
  }

  return {
    context, currentTab, sessionCurrent, busy, error, end, setEnd, save, continuePlanning,
    planningTargetUnit: currentProject?.novelConfig.writingLanguage === 'en-US' ? text('词', 'words') : text('字', 'characters'),
  }
}
