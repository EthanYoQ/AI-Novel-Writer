/**
 * 正文新角色候选的渲染进程状态。
 *
 * 「定稿时提了名 → 作者在角色页裁决」这条链路里，本 store 只做三件事：
 * 读待确认队列、记采纳、记忽略。真正**建档**不在这里 —— 它复用角色卡既有的
 * 新增通道（character-store.addNamedCharacters + saveAll），于是「候选转正」
 * 与「作者手工新建一个角色」走的是同一条落库路径，不存在第二套写法。
 * 差别只在带过去的内容：候选会把模型给出的 role 与 currentState 一并交过去
 * （先生报障：此前只传名字，新建的角色档里除名字以外一片空白）。
 *
 * 先生 2026-09-21 定的形态：「一键采纳即建档、忽略即丢弃。」
 *
 * 所有 db: 通道都带冻结会话 —— 主进程对缺会话的调用一律拒绝
 * （project-access.assertCurrentProjectContext），这是跨项目写保护的底线。
 */
import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { CharacterCandidateRecord } from '../shared/character-candidate'
import { characterRosterIdentityKey } from '../shared/character-roster'
import { useCharacterStore } from './character-store'

interface CharacterCandidateState {
  /** 当前项目的待确认队列。 */
  candidates: CharacterCandidateRecord[]
  /** 这份队列属于哪个项目 —— 切项目时旧数据不得继续显示。 */
  projectKey: string | null
  loading: boolean
  lastError: string | null

  load: (projectPath: string, projectSession: ProjectSessionContext) => Promise<void>
  /** 采纳：建档并落盘，成功后把候选记为已采纳。 */
  adopt: (
    candidateId: number,
    projectPath: string,
    projectSession: ProjectSessionContext,
  ) => Promise<boolean>
  /** 忽略：只记裁决，不碰角色名单。 */
  dismiss: (
    candidateId: number,
    projectPath: string,
    projectSession: ProjectSessionContext,
  ) => Promise<boolean>
  reset: () => void
}

export const useCharacterCandidateStore = create<CharacterCandidateState>()((set, get) => ({
  candidates: [],
  projectKey: null,
  loading: false,
  lastError: null,

  reset: () => set({ candidates: [], projectKey: null, loading: false, lastError: null }),

  load: async (projectPath, projectSession) => {
    if (!projectPath) return
    set({ loading: true, projectKey: projectPath })
    try {
      const rows = await ipc.invokeWithProjectSession(
        projectSession,
        'db:character-candidate-list',
        projectPath,
      )
      const candidates = Array.isArray(rows) ? rows as CharacterCandidateRecord[] : []
      // 读取期间可能已经切了项目：晚到的旧结果不许回填。
      set(state => (
        state.projectKey !== projectPath ? state : { candidates, loading: false, lastError: null }
      ))
    } catch (error) {
      set(state => (
        state.projectKey !== projectPath ? state : { loading: false, lastError: String(error) }
      ))
    }
  },

  adopt: async (candidateId, projectPath, projectSession) => {
    const candidate = get().candidates.find(item => item.id === candidateId)
    if (!candidate) return false
    const characters = useCharacterStore.getState()
    /**
     * ① 走既有的「按名字建卡」通道：它自己会去重、也会跳过已在名单里的名字 ——
     *    哪怕作者在待确认期间已经手动建过这张卡，这里也不会建出第二个。
     *
     *    名字之外**把 role 与 currentState 一并交过去**：候选里那两项是模型在定稿时
     *    从本章正文里读出来的（提示词一直要求它随 `newCharacters` 返回），
     *    此前只传名字，于是采纳建档出来的是张只有名字的空卡 —— 先生报障：
     *    「新档只有名字，里面没有任何的内容？」
     */
    characters.addNamedCharacters([{
      name: candidate.name,
      role: candidate.role,
      currentState: candidate.currentState,
    }])
    /**
     * ② 立刻落盘。先生说的一键采纳是「即建档」，不能只进草稿账本等他再点保存；
     *    saveAll 失败会 reject，草稿仍在本地可重试，此时绝不记采纳。
     */
    try {
      await characters.saveAll(projectPath, projectSession)
    } catch {
      return false
    }
    /**
     * ③ 落盘之后**核对一遍名字真的在名单里**，再谈记采纳。
     *
     * 「加名字」这一步有两种情况会静默不生效：名字早已存在（那本来就是已建档，
     * 算成功），或者 store 此刻还没就绪（那就是压根没建成）。若不核对就标记采纳，
     * 等于把这条提名悄悄吞掉 —— 作者既看不到卡，队列里也没了，正是这次要修的
     * 那类「无声消失」。
     */
    const identity = characterRosterIdentityKey(candidate.name)
    const persisted = useCharacterStore.getState().characters
      .some(card => characterRosterIdentityKey(card.name) === identity)
    if (!persisted) return false
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-candidate-resolve',
      [candidateId],
      'adopted',
      projectPath,
    ) as { success?: boolean } | undefined
    if (!result?.success) return false
    set(state => ({ candidates: state.candidates.filter(item => item.id !== candidateId) }))
    return true
  },

  dismiss: async (candidateId, projectPath, projectSession) => {
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-candidate-resolve',
      [candidateId],
      'dismissed',
      projectPath,
    ) as { success?: boolean } | undefined
    if (!result?.success) return false
    set(state => ({ candidates: state.candidates.filter(item => item.id !== candidateId) }))
    return true
  },
}))
