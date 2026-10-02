import { useState } from 'react'

import type { ModelProfile } from '../../shared/ipc-channels'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { resolveReasoningPolicy } from '../../shared/reasoning-policy'
import { modelCapabilitySource } from '../../shared/model-profile-draft'
import { resolveModelProfileReasoningMapping } from '../../shared/provider-presets'
import { isReasoningMapping } from '../../shared/reasoning-types'
import type {
  CreativeStrategy,
  EffectiveReasoningEffort,
  ReasoningEffort,
  ReasoningOverride,
  ReasoningResolutionStatus,
} from '../../shared/reasoning-types'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'

export function ModelCapabilitySources({ model }: { model: ModelProfile }) {
  const text = useLocaleStore(state => state.text)
  const labels = {
    endpoint: text('接口取得', 'Endpoint declaration'), preset: text('资料匹配', 'Catalog match'),
    manual: text('手动设置', 'Manual setting'), unknown: text('未识别', 'Unknown'),
  }
  return <div className="text-xs text-[var(--color-text-muted)]" data-capability-sources>
    {([
      ['contextWindowTokens', text('上下文', 'Context')], ['maxOutputTokens', text('模型输出容量', 'Model output capacity')],
      ['reasoning', text('推理能力', 'Reasoning capability')], ['structuredOutput', text('结构化输出', 'Structured output')],
      ['usage', text('用量报告', 'Usage reporting')],
    ] as const).map(([key, label]) => <span className="mr-3" key={key}>{label}：{labels[modelCapabilitySource(model, key)]}</span>)}
  </div>
}

export function ProjectCreativeStrategySettings() {
  const text = useLocaleStore(state => state.text)
  const currentProject = useProjectStore(state => state.currentProject)
  const updateNovelConfig = useProjectStore(state => state.updateNovelConfig)
  const saveProject = useProjectStore(state => state.saveProject)
  const [projectSaveState, setProjectSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const creativeStrategy = currentProject?.novelConfig.creativeStrategy ?? 'auto'
  const updateCreativeStrategy = async (value: CreativeStrategy) => {
    const session = projectSessionContextFromProject(currentProject)
    if (!session) return
    setProjectSaveState('saving')
    updateNovelConfig({ creativeStrategy: value }, session)
    const saved = await saveProject(session)
    setProjectSaveState(saved ? 'saved' : 'error')
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3">
      <Label>{text('创作策略（当前项目）', 'Creative strategy (current project)')}</Label>
      <NativeSelect
        value={creativeStrategy}
        disabled={!currentProject || projectSaveState === 'saving'}
        onChange={event => { void updateCreativeStrategy(event.target.value as CreativeStrategy) }}
        aria-label={text('创作策略（当前项目）', 'Creative strategy (current project)')}
      >
        <option value="auto">{text('自动', 'Auto')}</option>
        <option value="fluent-drafting">{text('流畅起草', 'Fluent drafting')}</option>
        <option value="consistency-first">{text('一致性优先', 'Consistency first')}</option>
        <option value="deep-planning">{text('深度规划', 'Deep planning')}</option>
      </NativeSelect>
      <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
        {!currentProject
          ? text('打开项目后可配置；该设置跟随项目，不随模型切换。', 'Open a project to configure this. It follows the project, not the selected model.')
          : projectSaveState === 'saving'
            ? text('正在保存项目策略…', 'Saving project strategy…')
            : projectSaveState === 'error'
              ? text('项目策略保存失败。', 'Could not save the project strategy.')
              : text('该设置跟随项目，不随模型切换。', 'This setting follows the project and does not change with the model.')}
      </p>
    </div>
  )
}

export function ModelReasoningOverrideSettings({
  model,
  onModelChange,
}: {
  model: ModelProfile
  onModelChange: (model: ModelProfile) => void
}) {
  const text = useLocaleStore(state => state.text)
  const creativeStrategy = useProjectStore(state => state.currentProject?.novelConfig.creativeStrategy ?? 'auto')
  const mapping = resolveModelProfileReasoningMapping(model)
  const switchOnly = mapping?.adapter === 'deepseek-v4-thinking'
    && Object.values(mapping.providerValues).every(value => value === 'enabled' || value === 'disabled')
  const [mappingDraft, setMappingDraft] = useState<string | null>(null)
  const [mappingError, setMappingError] = useState(false)
  const applyMapping = () => {
    try {
      const raw = mappingDraft ?? JSON.stringify(model.reasoningMapping ?? null, null, 2)
      const value: unknown = raw.trim() ? JSON.parse(raw) : undefined
      if (value !== undefined && value !== null && (!isReasoningMapping(value)
        || (model.protocol === 'gemini') !== (value.adapter === 'gemini-thinking-budget'))) throw new Error('mapping')
      onModelChange({ ...model, reasoningMapping: value == null ? undefined : value as ModelProfile['reasoningMapping'] })
      setMappingDraft(null)
      setMappingError(false)
    } catch { setMappingError(true) }
  }
  const effortLabel = (value: ReasoningEffort | EffectiveReasoningEffort | null): string => {
    if (value === null) return '—'
    return {
      off: text('关闭', 'Off'),
      low: text('低', 'Low'),
      medium: text('中', 'Medium'),
      high: text('高', 'High'),
      xhigh: text('极高', 'XHigh'),
      max: text('最高', 'Max'),
    }[value]
  }
  const drafting = resolveReasoningPolicy({ model, creativeStrategy, stage: 'drafting' })
  const planning = resolveReasoningPolicy({
    model,
    creativeStrategy,
    stage: 'planning',
  })
  const review = resolveReasoningPolicy({
    model,
    creativeStrategy,
    stage: 'review',
  })

  const statusLabel = (status: ReasoningResolutionStatus) => ({
    mapped: text('已映射', 'Mapped'),
    capped: text('已限制', 'Capped'),
    forced: text('模型强制', 'Model-forced'),
    unsupported: text('未发送 / 供应商默认', 'Not sent / provider default'),
  }[status])

  const outcome = (
    label: string,
    resolution: typeof drafting,
  ) => (
    <div className="flex items-center justify-between gap-3 text-xs" data-reasoning-status={resolution.status}>
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="text-right text-[var(--color-text)]">
        {effortLabel(resolution.requested)} → {effortLabel(resolution.effective)}
        <span className="ml-1 text-[var(--color-text-muted)]">({statusLabel(resolution.status)})</span>
        {resolution.providerDirective && <span className="ml-1" data-reasoning-wire>
          {resolution.providerDirective.adapter === 'gemini-thinking-budget'
            ? `thinking_budget=${resolution.providerDirective.thinkingBudget}`
            : resolution.providerDirective.adapter === 'deepseek-v4-thinking'
              ? `thinking=${resolution.providerDirective.thinking}${resolution.providerDirective.thinking === 'enabled' && resolution.providerDirective.reasoningEffort ? `; reasoning_effort=${resolution.providerDirective.reasoningEffort}` : ''}`
              : `${resolution.providerDirective.adapter === 'siliconflow-v4-thinking' ? 'enable_thinking=true; ' : ''}reasoning_effort=${resolution.providerDirective.reasoningEffort}`}
        </span>}
      </span>
    </div>
  )

  return (
    <div className="space-y-3" data-model-reasoning-override-settings>
      <div>
        <Label>{text('模型推理覆盖', 'Model reasoning override')}</Label>
        <NativeSelect
          value={model.reasoningOverride ?? 'auto'}
          onChange={event => onModelChange({
            ...model,
            reasoningOverride: event.target.value as ReasoningOverride,
          })}
          aria-label={text('模型推理覆盖', 'Model reasoning override')}
        >
          <option value="auto">{text('自动（遵循项目与阶段）', 'Auto (project and stage)')}</option>
          <option value="off">{text('关闭', 'Off')}</option>
          <option value="low">{text('低', 'Low')}</option>
          <option value="medium">{text('中', 'Medium')}</option>
          <option value="high">{text('高', 'High')}</option>
          <option value="xhigh">{text('极高', 'XHigh')}</option>
          <option value="max">{text('最高', 'Max')}</option>
        </NativeSelect>
        <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
          {text(
            '这是请求偏好，不是跨服务商的统一质量刻度；实际值取决于已验证的模型映射。',
            'This is a request preference, not a universal quality scale; the effective value depends on a verified model mapping.',
          )}
        </p>
      </div>
      <details>
        <summary className="text-xs cursor-pointer">{text('高级参数映射', 'Advanced parameter mapping')}</summary>
        <p className="text-xs">{text('仅按服务文档填写现有适配器映射；应用后再保存配置。清空恢复自动匹配。', 'Use documented adapter mappings. Apply, then save the profile. Clear to restore automatic matching.')}</p>
        <textarea aria-label={text('推理参数映射 JSON', 'Reasoning mapping JSON')} className="w-full font-mono text-xs" rows={6}
          value={mappingDraft ?? JSON.stringify(model.reasoningMapping ?? null, null, 2)}
          onChange={event => { setMappingDraft(event.target.value); setMappingError(false) }} />
        <button type="button" onClick={applyMapping}>{text('应用映射', 'Apply mapping')}</button>
        {mappingError && <p role="alert">{text('映射无效，未应用。请检查适配器、档位和值类型。', 'Invalid mapping; not applied. Check adapter, efforts and value types.')}</p>}
      </details>

      <div className="space-y-1.5 rounded-md bg-[var(--color-bg)] p-2" aria-label={text('实际生效推理强度', 'Effective reasoning effort')}>
        <p className="text-xs">{model.reasoningMapping ? text('手动设置', 'Manual setting')
          : mapping ? text('资料匹配', 'Catalog match') : text('未识别 / 服务默认', 'Unknown / provider default')}</p>
        {switchOnly && <p className="text-xs">{text('仅支持思考开关', 'Thinking toggle only')}</p>}
        {outcome(text('章节起草', 'Chapter drafting'), drafting)}
        {outcome(text('故事规划', 'Story planning'), planning)}
        {outcome(text('审稿与修订', 'Review and revision'), review)}
      </div>
      <p className="text-[0.7rem] text-[var(--color-text-muted)]">
        {text(
          '原始推理不会作为章节正文或写入小说长期记忆。',
          'Raw reasoning is not treated as chapter prose or persisted into long-term novel memory.',
        )}
      </p>
    </div>
  )
}

export default function ReasoningPolicySettings(props: {
  model: ModelProfile
  onModelChange: (model: ModelProfile) => void
}) {
  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-3" data-reasoning-policy-settings>
      <ProjectCreativeStrategySettings />
      <ModelReasoningOverrideSettings {...props} />
    </div>
  )
}
