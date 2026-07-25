export interface CharacterExtractionReadiness {
  projectKey: string
  dataProjectKey: string | null
  loadingProjectKey: string | null
  lastError: string | null
  characterCount: number
}

/**
 * 零条角色只有在当前项目角色数据已成功加载并完成绑定后才代表“真的为空”。
 * 加载中、未绑定或加载失败都不能开放会覆盖角色记录的重新提取操作。
 */
export function isCharacterExtractionReady(
  state: CharacterExtractionReadiness,
): boolean {
  return state.dataProjectKey === state.projectKey
    && state.loadingProjectKey === null
    && state.lastError === null
    && state.characterCount === 0
}
