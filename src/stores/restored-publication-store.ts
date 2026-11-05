import { create } from 'zustand'
import type { ProjectSessionContext } from '../shared/ipc-channels'

interface RestoredPublication {
  finalizationId: string
  publication: 'pending' | 'published'
}

/**
 * 从回收站恢复、实体稿没写出的定稿，按会话租约与稿号记。
 * 单章视图渲染时按自己的稿号来读，不交给标签：这一章的标签怎么打开、开了几次都看得到「重新写入正文」。
 * 重写成功后标成 published，直到换作品或重开。
 */
export const useRestoredPublicationStore = create<Record<string, RestoredPublication>>()(() => ({}))

export const restoredPublicationKey = (leaseId: string, draftId: number) => `${leaseId}\n${draftId}`

/** 每次放回原位都按这次的结果覆盖：同一稿删了又恢复、这次写出来了，上一次的待写记录不能留着。 */
export function recordRestoredPublication(session: ProjectSessionContext, draftId: number, finalizationId: string, publication: 'pending' | 'published'): void {
  const key = restoredPublicationKey(session.leaseId, draftId)
  useRestoredPublicationStore.setState(state => {
    const next = { ...state }
    if (publication === 'pending') next[key] = { finalizationId, publication }
    else delete next[key]
    return next
  }, true)
}

export function markRestoredPublished(leaseId: string, draftId: number, finalizationId: string): void {
  const key = restoredPublicationKey(leaseId, draftId)
  if (useRestoredPublicationStore.getState()[key]?.finalizationId !== finalizationId) return
  useRestoredPublicationStore.setState({ [key]: { finalizationId, publication: 'published' } })
}
