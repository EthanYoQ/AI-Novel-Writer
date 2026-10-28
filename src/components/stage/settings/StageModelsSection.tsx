import { useId, useRef, useState } from 'react'
import { ArrowRight, Plus } from 'lucide-react'
import { MODEL_STAGES, isGenerationModel, routeStageModel, type ModelStage } from '../../../shared/model-stage-routing'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { leaveSettings } from '../../settings/unsaved-settings'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { Notice } from '../../ui/Notice'

type Pair = readonly [string, string]

const STAGE_COPY: Record<ModelStage, { name: Pair; scope: Pair }> = {
  planning: {
    name: ['规划', 'Planning'],
    scope: ['设定、架构、角色、大纲与蓝图；剧情树与伏笔线索；资料提取、文风分析、导入和旧角色名单修复。',
      'Setup, architecture, characters, outline and blueprints; the plot tree and foreshadowing threads; material extraction, style analysis, imports and legacy cast repair.'],
  },
  drafting: {
    name: ['写稿', 'Drafting'],
    scope: ['单章与批量写作、编辑器行内改写。', 'Chapter and batch drafting, and inline edits in the editor.'],
  },
  review: {
    name: ['审稿', 'Review'],
    scope: ['AI 审稿。合并后的复验沿用首次审稿的模型。', 'AI reviews. The check after merging keeps the model of the first review.'],
  },
  refinement: {
    name: ['修稿', 'Revision'],
    scope: ['按审稿意见修稿、直接修稿。', 'Revisions from review notes and direct revisions.'],
  },
  finalization: {
    name: ['定稿后处理', 'After finalizing'],
    scope: ['单章「定稿…」后的首次后处理。批量写作的自动定稿、导入中的后处理，以及已跑过步骤的修复和重试，沿用原来的模型。',
      'The first post-processing after you finalize a single chapter. Auto-finalizing in batch writing, post-processing during imports, and repairs or retries of steps that already ran keep their original model.'],
  },
}

const openModels = () => leaveSettings(() => useLayoutStore.setState({ settingsSection: 'llm' }))

export default function StageModelsSection() {
  const text = useLocaleStore(s => s.text)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const stageModelIds = useLLMStore(s => s.stageModelIds)
  const setStageModel = useLLMStore(s => s.setStageModel)
  const [pending, setPending] = useState<Partial<Record<ModelStage, string>>>({})
  const latestRequest = useRef<Partial<Record<ModelStage, number>>>({})
  const idPrefix = useId()
  const generationModels = models.filter(isGenerationModel)
  const label = (modelId: string | null) => {
    const model = generationModels.find(candidate => candidate.id === modelId)
    return model ? model.name || model.modelName : null
  }
  const toModels = <Button variant="secondary" size="sm" onClick={openModels}>{text('去 AI 模型', 'Go to AI models')}<ArrowRight size={14} aria-hidden="true" /></Button>

  if (generationModels.length === 0) {
    return (
      <div className="stage-set-card">
        <EmptyState
          heading={text('还没有生成模型', 'No generation models yet')}
          description={text('先在「AI 模型」里添加，再回来给各环节分工。', 'Add one in AI models first, then come back to assign stages.')}
          action={<Button variant="primary" onClick={openModels}><Plus size={14} aria-hidden="true" />{text('去添加模型', 'Add a model')}</Button>}
        />
      </div>
    )
  }

  const defaultLabel = label(defaultModelId)
  const single = generationModels.length === 1 && defaultLabel !== null
  const choose = async (stage: ModelStage, modelId: string | null) => {
    const request = (latestRequest.current[stage] ?? 0) + 1
    latestRequest.current[stage] = request
    setPending(current => ({ ...current, [stage]: modelId ?? '' }))
    await setStageModel(stage, modelId)
    if (latestRequest.current[stage] !== request) return
    setPending(current => {
      const next = { ...current }
      delete next[stage]
      return next
    })
  }

  return (
    <>
      {single && (
        <Notice tone="info" title={text('只有一个生成模型时，各环节都用它', 'With one generation model, every stage uses it')} actions={toModels}>
          {text('在「AI 模型」里再添加一个，就能给环节分工。', 'Add another in AI models to split the work.')}
        </Notice>
      )}
      <div className="stage-set-rows">
        {MODEL_STAGES.map(stage => {
          const route = routeStageModel(stage, { models, defaultModelId, stageModelIds })
          const selectId = `${idPrefix}-${stage}`
          const saving = pending[stage] !== undefined
          const value = pending[stage] ?? (route.source === 'stage' ? route.modelId : '')
          return (
            <div key={stage} className="stage-set-row" data-stage={stage}>
              <div>
                <label className="stage-set-row-title" htmlFor={selectId}>{text(...STAGE_COPY[stage].name)}</label>
                <p className="stage-set-row-desc">{text(...STAGE_COPY[stage].scope)}</p>
              </div>
              <div className="stage-set-row-ctl">
                <select id={selectId} className="stage-select" value={value} disabled={single} aria-busy={saving}
                  onChange={event => void choose(stage, event.target.value || null)}>
                  <option value="">{defaultLabel ? text(`跟随默认（${defaultLabel}）`, `Default (${defaultLabel})`) : text('跟随默认（未设置）', 'Default (not set)')}</option>
                  {generationModels.map(model => <option key={model.id} value={model.id}>{model.name || model.modelName}</option>)}
                </select>
              </div>
              {route.staleAssignmentId && !saving && (
                <div className="stage-set-row-extra">
                  <p className="stage-set-stale">
                    <span role="status">{route.source === 'none'
                      ? text('所选模型已删除或不能用于文本生成，默认模型也不可用，这个环节现在无法运行。', 'The selected model was deleted or can no longer generate text, and there is no usable default, so this stage cannot run.')
                      : text('所选模型已删除或不能用于文本生成，现按默认模型运行。', 'The selected model was deleted or can no longer generate text, so the default is used.')}</span>
                    <Button variant="text" size="sm" onClick={() => void choose(stage, null)}>{text('改回跟随默认', 'Use the default')}</Button>
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <p className="stage-set-foot">
        {text('默认模型在「AI 模型」里设置。', 'The default model is set in AI models.')}
        <Button variant="text" size="sm" onClick={openModels}>{text('去 AI 模型', 'Go to AI models')}</Button>
      </p>
    </>
  )
}
