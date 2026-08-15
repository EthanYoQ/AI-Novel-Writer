import { useState } from 'react'

import type { ModelProfile } from '../../shared/ipc-channels'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { resolveReasoningPolicy } from '../../shared/reasoning-policy'
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

function effortLabel(value: ReasoningEffort | EffectiveReasoningEffort | null): string {
  if (value === null) return '—'
  return value === 'max' ? 'Max' : value.charAt(0).toUpperCase() + value.slice(1)
}

export default function ReasoningPolicySettings({
  model,
  onModelChange,
}: {
  model: ModelProfile
  onModelChange: (model: ModelProfile) => void
}) {
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

  const drafting = resolveReasoningPolicy({
    model,
    creativeStrategy,
    purpose: 'chapter-draft',
  })
  const planning = resolveReasoningPolicy({
    model,
    creativeStrategy,
    purpose: 'chapter-blueprint',
  })
  const review = resolveReasoningPolicy({
    model,
    creativeStrategy,
    purpose: 'review-chapter',
  })

  const statusLabel = (status: ReasoningResolutionStatus) => ({
    mapped: text('已映射', 'Mapped'),
    capped: text('已限制', 'Capped'),
    forced: text('模型强制', 'Model-forced'),
    unsupported: text('不支持 / 不发送参数', 'Unsupported / no parameter sent'),
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
      </span>
    </div>
  )

  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-3" data-reasoning-policy-settings>
      <div>
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

      <div>
        <Label>{text('模型推理覆盖（高级）', 'Model reasoning override (advanced)')}</Label>
        <NativeSelect
          value={model.reasoningOverride ?? 'auto'}
          onChange={event => onModelChange({
            ...model,
            reasoningOverride: event.target.value as ReasoningOverride,
          })}
          aria-label={text('模型推理覆盖（高级）', 'Model reasoning override (advanced)')}
        >
          <option value="auto">{text('自动（遵循项目与阶段）', 'Auto (project and stage)')}</option>
          <option value="off">Off</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="max">Max</option>
        </NativeSelect>
        <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
          {text(
            '这是请求偏好，不是跨服务商的统一质量刻度；实际值取决于已验证的模型映射。',
            'This is a request preference, not a universal quality scale; the effective value depends on a verified model mapping.',
          )}
        </p>
      </div>

      <div className="space-y-1.5 rounded-md bg-[var(--color-bg)] p-2" aria-label={text('实际生效推理强度', 'Effective reasoning effort')}>
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
