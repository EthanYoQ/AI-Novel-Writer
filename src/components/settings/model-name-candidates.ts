import type { DiscoveredModel } from '../../shared/ipc-channels'
import type { ModelCapabilities } from '../../shared/provider-presets'

export interface ModelNameCandidate {
  value: string
  label?: string
  fromPreset: boolean
  endpointCapabilities?: Partial<ModelCapabilities>
}

export function modelNameCandidates(presetNames: readonly string[], discovered: readonly DiscoveredModel[] | null): ModelNameCandidate[] {
  if (!discovered) return presetNames.map(value => ({ value, fromPreset: true }))
  const endpointModels = new Map(discovered.map(model => [model.value, model]))
  const presets = new Set(presetNames)
  return [
    ...presetNames.filter(name => endpointModels.has(name))
      .map(value => ({ value, fromPreset: true, endpointCapabilities: endpointModels.get(value)?.capabilities })),
    ...discovered.filter(model => !presets.has(model.value)).map(model => ({
      value: model.value,
      label: model.name !== model.value && model.name !== model.id ? model.name : undefined,
      fromPreset: false,
      endpointCapabilities: model.capabilities,
    })),
  ]
}
