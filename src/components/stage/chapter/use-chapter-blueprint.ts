import { useEffect, useState } from 'react'
import { globalEventBus } from '../../../shared/event-bus'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'

type Blueprint = Awaited<ReturnType<typeof readBlueprint>>

function readBlueprint(chapterNumber: number, projectKey: string) {
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  if (!session || !isProjectSessionPath(session, projectKey)) return Promise.resolve(null)
  return ipc.invokeWithProjectSession(session, 'db:blueprint-get', chapterNumber, session.projectPath)
}

/**
 * 这一章的蓝图：读到之前为 undefined，没有蓝图为 null；读取出错时 failed 为 true、蓝图仍是 undefined，
 * 不当成没有蓝图（那会清掉写作请求、提示去规划）。蓝图资源刷新或 reload 时重读。
 */
export function useChapterBlueprint(chapterNumber: number | undefined, projectKey: string): { blueprint: Blueprint | undefined; failed: boolean; reload: () => void } {
  const [state, setState] = useState<{ blueprint: Blueprint | undefined; failed: boolean }>({ blueprint: undefined, failed: false })
  const [version, setVersion] = useState(0)
  useEffect(() => globalEventBus.on('REFRESH_RESOURCE', ({ projectSession, resources }) => {
    if (isProjectSessionCurrent(projectSession) && resources.some(kind => kind === 'blueprints' || kind === 'all')) setVersion(v => v + 1)
  }), [])
  useEffect(() => {
    if (chapterNumber === undefined) return
    let cancelled = false
    void readBlueprint(chapterNumber, projectKey)
      .then(next => { if (!cancelled) setState({ blueprint: next, failed: false }) })
      .catch(() => { if (!cancelled) setState({ blueprint: undefined, failed: true }) })
    return () => { cancelled = true }
  }, [chapterNumber, projectKey, version])
  return { ...state, reload: () => setVersion(v => v + 1) }
}

