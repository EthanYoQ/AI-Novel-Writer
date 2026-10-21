import { useCallback, useState } from 'react'

import { countUnsavedEditorItems } from '../../stores/editor-unsaved'
import { useEditorStore } from '../../stores/editor-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { discardChangesThenRequestInstall } from './update-install-discard'

export type UpdateInstallBlock = 'workflow' | 'unsaved'

/**
 * 重启更新前的拦截：有创作任务时只能返回处理任务；有未保存修改时返回保存，或明确放弃后再重启。
 * 书房的更新卡与设置里的「关于与更新」共用。
 */
export function useUpdateInstallGuard(requestInstall: () => Promise<void>) {
  const tabs = useEditorStore(s => s.tabs)
  const draftLedgers = useEditorStore(s => s.draftLedgers)
  const activeRunCount = useWorkflowStore(s => s.activeRuns.length)
  const [block, setBlock] = useState<UpdateInstallBlock | null>(null)
  const unsavedItemCount = countUnsavedEditorItems(tabs, draftLedgers)

  const install = useCallback(() => {
    // 活跃任务集合中标记为已完成或失败的任务，也可能正处在最终落盘和移入历史之间，
    // 因此不能只检查运行中、已暂停或等待中的状态。
    if (useWorkflowStore.getState().activeRuns.length > 0) {
      setBlock('workflow')
      return
    }
    if (unsavedItemCount > 0) {
      setBlock('unsaved')
      return
    }
    void requestInstall()
  }, [requestInstall, unsavedItemCount])

  const discardAndInstall = useCallback(() => {
    setBlock(null)
    // 用户停留在未保存确认框期间也可能启动任务，最终安装动作前必须再次检查。
    if (useWorkflowStore.getState().activeRuns.length > 0) {
      setBlock('workflow')
      return
    }
    void discardChangesThenRequestInstall(requestInstall)
  }, [requestInstall])

  return {
    block,
    /** 只关掉指定的拦截：确认放弃后重查到任务时已换成任务拦截，随后确认框自己的关闭不能把它也关掉。 */
    dismiss: (kind: UpdateInstallBlock) => setBlock(current => (current === kind ? null : current)),
    install,
    discardAndInstall,
    unsavedItemCount,
    activeRunCount,
  }
}
