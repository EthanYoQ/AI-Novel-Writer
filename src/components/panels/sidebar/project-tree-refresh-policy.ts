import { LatestRequestGate } from '../../editor/latest-request-gate'

export interface ProjectTreeIdentityTransition {
  requestId: number
  hasProject: boolean
  projectSessionEpoch: number
}

/** 每次项目身份变化都推进令牌；关闭后重开同一路径也不会复用旧请求。 */
export function beginProjectTreeIdentityTransition(
  gate: LatestRequestGate,
  projectPath: string | undefined,
  projectSessionEpoch: number,
): ProjectTreeIdentityTransition {
  return {
    requestId: gate.begin(),
    hasProject: Boolean(projectPath),
    projectSessionEpoch,
  }
}
