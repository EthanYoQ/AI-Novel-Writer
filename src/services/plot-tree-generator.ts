import { generateGraphResult } from './graph-generation'
import type { PlotTreeSnapshot, PlotTreeSourceBundle } from '../shared/plot-tree'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { buildPlotTreeTask, derivePlotTreeSnapshot, PLOT_TREE_GENERATION_BUDGET, PlotTreeIncompleteError, PlotTreeGenerationError } from '../shared/plot-tree-generation-pure'
export * from '../shared/plot-tree-generation-pure'
import { GenerationHarnessError } from './generation/generation-harness'
import {
  type CreateGenerationRuntimeOptions,
  type GenerationRuntime,
} from './generation/generation-runtime'

export interface GeneratePlotTreeInput {
  modelId: string
  projectSession: ProjectSessionContext
  sources: PlotTreeSourceBundle
  signal: AbortSignal
}

export interface PlotTreeGeneratorDependencies {
  createRuntime(options: CreateGenerationRuntimeOptions): Promise<GenerationRuntime>
  now(): string
}

export async function generatePlotTree(
  input: GeneratePlotTreeInput,
  dependencies?: PlotTreeGeneratorDependencies,
): Promise<PlotTreeSnapshot> {
  if (!dependencies) {
    const result = await generateGraphResult(input.projectSession, { kind: 'plot' }, input.modelId, input.signal)
    if (result.kind !== 'plot') throw new Error('GRAPH_GENERATION_KIND_MISMATCH')
    return result.snapshot
  }
  const task = buildPlotTreeTask(input.sources)
  const runtime = await dependencies.createRuntime({
    budget: PLOT_TREE_GENERATION_BUDGET,
    modelId: input.modelId,
    projectSession: input.projectSession,
  })
  try {
    return await runtime.execute(async ({ session }) => {
      const outcome = await session.complete(task, { signal: input.signal })
      if (outcome.status !== 'completed') {
        throw new PlotTreeIncompleteError(input.sources.writingLanguage, outcome.finishReason)
      }
      return derivePlotTreeSnapshot(outcome.content, input.sources, dependencies.now()).snapshot
    })
  } catch (error) {
    if (error instanceof GenerationHarnessError
      && (error.code === 'DEADLINE_EXHAUSTED' || error.code === 'PROVIDER_REQUEST_FAILED')) {
      throw new PlotTreeGenerationError(error.code)
    }
    throw error
  } finally {
    await runtime.close().catch(() => {})
  }
}
