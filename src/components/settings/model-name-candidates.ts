import type { DiscoveredModel } from '../../shared/ipc-channels'
import type { ModelCapabilities } from '../../shared/provider-presets'

export interface ModelNameCandidate {
  value: string
  /** 端点给的显示名；与模型 ID 相同时不单独显示。 */
  label?: string
  /** 服务商预设里的模型，能力与推理映射由预设目录按模型名解析。 */
  recommended: boolean
  /** 只来自端点列表的明确声明。 */
  declared?: Partial<ModelCapabilities>
}

/**
 * 候选列表的唯一来源：取到端点列表时以端点为准，其中与预设同名的标为推荐并排在前面；
 * 没取到（未获取、失败或端点不支持）时用预设兜底。
 */
export function modelNameCandidates(presetNames: readonly string[], discovered: readonly DiscoveredModel[] | null): ModelNameCandidate[] {
  if (!discovered) return presetNames.map(value => ({ value, recommended: true }))
  // 网关可能以预设同名提供模型，此时预设目录按地址认不出它，端点的明确声明不能丢。
  const endpointModels = new Map(discovered.map(model => [model.value, model]))
  const presets = new Set(presetNames)
  return [
    ...presetNames.filter(name => endpointModels.has(name))
      .map(value => ({ value, recommended: true, declared: endpointModels.get(value)?.capabilities })),
    ...discovered.filter(model => !presets.has(model.value)).map(model => ({
      value: model.value,
      label: model.name !== model.value && model.name !== model.id ? model.name : undefined,
      recommended: false,
      declared: model.capabilities,
    })),
  ]
}
