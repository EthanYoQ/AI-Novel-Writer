/**
 * 角色卡候选的「确认 → 提交」控制器（两个入口共用）。
 *
 * 创作资料提取角色卡有两处入口：
 *   · 角色栏的「粘贴 / 导入角色卡」（CharacterCardImportButton）；
 *   · 知识库页的「导入创作资料并提取角色」（KnowledgeOverview）。
 *
 * 旧实现两处都缺预览确认：一处把「确认」塞成任务面板里的一个继续按钮，另一处连
 * 入口都没有，工作流跑完就直接报成功。把状态机收在这里，两处行为必然一致，
 * 也不会各自漏掉边界。
 *
 * 健壮性约定：
 *   · 交付候选时校验会话：项目已切换就明确告知，绝不静默丢弃、也绝不写进别的项目；
 *   · 0 条候选是合法结果，给中性提示 —— 绝不沿用「已导入角色名单」那句成功语；
 *   · 提交标识按「批次 + 勾选内容」派生：同一次提交重试幂等，改了勾选就是新提交；
 *   · 提交失败一律**保留候选**并就地说明原因，作者修好外部条件即可原地重试；
 *   · 待处理标志用 ref 而非 state：发起提取的异步收尾拿到的是旧闭包，读 state 会
 *     读到过期值，从而在候选面板之上再弹一次输入框。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { useLocaleStore } from '../../stores/locale-store'
import { useCharacterStore } from '../../stores/character-store'
import { useProjectStore } from '../../stores/project-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { CharacterRosterEntry } from '../../shared/character-roster'
import { commitPlanningMaterialCharacters } from '../../services/planning-material-character-commit'
import { toast } from '../ui/Toast'

/**
 * 提交成功后立刻按**当前会话**重载角色名单。
 *
 * 为什么不只依赖广播刷新：`REFRESH_RESOURCE` 会经过会话校验，会话对不上时
 * 整次刷新被静默跳过 —— 作者就会遇到「提示已写入，列表与档案里却查不到新
 * 角色」这种最让人心慌的状态。提交者自己重载一次，这条路不再依赖别人是否
 * 接受广播。
 */
async function reloadCurrentRoster(): Promise<void> {
  // 直接读当前项目会话，不再依赖模块级「活动会话」——后者一旦因时序失配，
  // 这里就静默跳过刷新，导致渲染层的 rosterRevision 落后于主进程，后续手动
  // 保存会被乐观锁以「revision 已过期」拒绝。
  const currentSession = projectSessionContextFromProject(useProjectStore.getState().currentProject)
  if (!currentSession) return
  await useCharacterStore.getState().load(currentSession.projectPath, currentSession)
}

interface CandidateBatch {
  id: string
  attempt: number
  selectionKey: string
}

const EMPTY_BATCH: CandidateBatch = { id: '', attempt: 0, selectionKey: '' }

export interface CharacterCardCandidateController {
  candidates: CharacterRosterEntry[]
  open: boolean
  busy: boolean
  error: string
  /** 是否还有一批候选等待作者处理；闭包安全，供发起方在异步收尾时判断。 */
  hasPending: () => boolean
  /** 工作流的完成交付口：把提取结果交给作者过目。 */
  deliver: (candidates: readonly CharacterRosterEntry[], session: ProjectSessionContext) => void
  /**
   * 作者确认：只写入勾选的条目。返回是否写入成功。
   * `overwriteExisting` 表示同名角色按候选内容更新（覆盖或逐项合并的结果）。
   */
  submit: (selected: CharacterRosterEntry[], overwriteExisting?: boolean) => Promise<boolean>
  /** 作者放弃：丢弃候选，不写入任何东西。 */
  discard: () => void
}

export function useCharacterCardCandidates(options: {
  /** 写入成功后回调（例如清空输入草稿）。 */
  onCommitted?: (savedCount: number) => void
} = {}): CharacterCardCandidateController {
  const { text } = useLocaleStore()
  const [candidates, setCandidates] = useState<CharacterRosterEntry[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const batchRef = useRef<CandidateBatch>(EMPTY_BATCH)
  const sessionRef = useRef<ProjectSessionContext | null>(null)
  const pendingRef = useRef(false)
  /** 每次渲染后刷新，读取的永远是最新回调，不会因闭包过期而漏掉清理动作。 */
  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options })

  const deliver = useCallback((
    ready: readonly CharacterRosterEntry[],
    session: ProjectSessionContext,
  ) => {
    if (!isProjectSessionCurrent(session)) {
      toast.warning(text(
        '项目已切换，本次提取的角色卡未显示，也未写入任何项目。',
        'The project changed, so these candidates were neither shown nor written anywhere.',
      ))
      return
    }
    if (ready.length === 0) {
      toast.info(text(
        '资料中没有发现明确角色，角色名单未改动。可以补充资料后再试。',
        'No explicit characters were found, so the roster was left unchanged. Add more material and try again.',
      ))
      return
    }
    sessionRef.current = session
    batchRef.current = { id: crypto.randomUUID(), attempt: 0, selectionKey: '' }
    pendingRef.current = true
    setCandidates([...ready])
    setError('')
    setOpen(true)
  }, [text])

  const submit = useCallback(async (
    selected: CharacterRosterEntry[],
    overwriteExisting = false,
  ) => {
    const session = sessionRef.current
    const batch = batchRef.current
    if (!session || !batch.id) {
      setError(text('这批候选已失效，请重新提取后再试。', 'These candidates expired. Run the extraction again.'))
      return false
    }
    // 勾选内容相同 = 同一次提交的重试，复用同一个操作标识（仓库层幂等去重）；
    // 勾选变了（或同名处理方式变了）= 另一次提交，必须换标识，否则仓库层会因
    // payload 不同而拒绝。
    const selectionKey = `${overwriteExisting ? 'overwrite' : 'keep'}\u0002${
      selected.map(entry => `${entry.name}\u0000${entry.role}`).join('\u0001')}`
    const attempt = batch.selectionKey === selectionKey ? batch.attempt : batch.attempt + 1
    batchRef.current = { ...batch, attempt, selectionKey }

    setBusy(true)
    setError('')
    try {
      const result = await commitPlanningMaterialCharacters({
        session,
        entries: selected,
        operationId: `planning-material-${batch.id}-${attempt}`,
        overwriteExisting,
      })
      if (!result.success) {
        // 保留候选：作者改好外部条件（例如先处理旧角色数据）后可以原地重试，
        // 不必再花一次模型调用。
        setError(result.error)
        return false
      }
      setCandidates([])
      setOpen(false)
      setError('')
      batchRef.current = EMPTY_BATCH
      sessionRef.current = null
      pendingRef.current = false
      optionsRef.current.onCommitted?.(result.savedCount)
      // 先让新角色出现在列表与档案里，再报成功 —— 作者的下一步就是去看它们。
      await reloadCurrentRoster()
      toast.success(overwriteExisting
        ? text(
            `已写入 ${result.savedCount} 张角色卡；同名角色按你的选择更新`,
            `Added ${result.savedCount} character cards; same-name entries were updated as you chose.`,
          )
        : text(
            `已写入 ${result.savedCount} 张角色卡；同名条目保留了你原有的内容`,
            `Added ${result.savedCount} character cards; entries of the same name kept your own text.`,
          ))
      return true
    } finally {
      setBusy(false)
    }
  }, [text])

  const discard = useCallback(() => {
    if (busy) return
    setCandidates([])
    setOpen(false)
    setError('')
    batchRef.current = EMPTY_BATCH
    sessionRef.current = null
    pendingRef.current = false
    toast.info(text(
      '已丢弃这批候选，角色名单未改动。',
      'These candidates were discarded and the roster is unchanged.',
    ))
  }, [busy, text])

  const hasPending = useCallback(() => pendingRef.current, [])

  return { candidates, open, busy, error, deliver, submit, discard, hasPending }
}
