import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'

/** This checkpoint stores navigation only; main validates the actual run and sources. */
export function architectureRecoveryHandle(value: unknown, kind: 'worldbuilding' | 'synopsis', projectId: string): MainGenerationRunHandle | undefined {
  if (!value || typeof value !== 'object') return undefined
  const partial = value as Record<string, unknown>
  const prefix = kind === 'worldbuilding' ? 'world_building' : 'synopsis'
  if (partial[`${prefix}_incomplete`] !== true) return undefined
  const handle = partial[`${prefix}_generation_handle`] as MainGenerationRunHandle | undefined
  if (!handle || typeof handle !== 'object' || Array.isArray(handle) || handle.projectId !== projectId
    || Object.keys(handle).length !== 4
    || ['projectId', 'epoch', 'rootActionId', 'runId'].some(key => typeof handle[key as keyof MainGenerationRunHandle] !== 'string' || !handle[key as keyof MainGenerationRunHandle].trim())) return undefined
  return Object.freeze({ ...handle })
}
