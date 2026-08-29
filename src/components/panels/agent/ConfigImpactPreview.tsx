/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState } from 'react'

import type { BlueprintData } from '../../../../electron/repositories/blueprint-repository'
import type { DraftMeta } from '../../../../electron/repositories/draft-repository'
import type { NarrativeThreadView } from '../../../shared/narrative-thread'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../../shared/project-session-context'
import type {
  ConfigImpactBlueprintProposal,
  ToolCallInfo,
} from '../../../services/agent/agent-engine'
import { buildChapterBlueprintProposal } from '../../../services/agent/tools/propose-chapter-blueprint.tool'
import { ipc } from '../../../services/ipc-client'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import {
  BLUEPRINT_LABELS,
  CONFIG_LABELS,
  type DomainProposalPreview,
} from './DomainProposalDiff'

const STORY_FACT_FIELDS = new Set([
  'genre', 'subGenre', 'totalChapters', 'plotStructure', 'narrativePOV', 'coreOutline',
  'worldSetting', 'goldenFinger', 'protagonistProfile', 'globalGuidance',
])

interface ImpactBlueprint {
  chapterNumber: number
  title: string
}

interface FinalizedChapter {
  chapterNumber: number
  title: string
}

interface SelectableBlueprintProposal extends ConfigImpactBlueprintProposal {
  key: string
  chapterNumber: number
  chapterTitle: string
  field: string
  current: unknown
  proposed: unknown
}

export type ConfigImpactPreviewState =
  | { kind: 'none'; changedFields: string[] }
  | { kind: 'loading'; changedFields: string[] }
  | { kind: 'stale'; changedFields: string[] }
  | { kind: 'invalid'; changedFields: string[]; error?: string }
  | {
      kind: 'valid'
      changedFields: string[]
      unwrittenBlueprints: ImpactBlueprint[]
      activeThreads: NarrativeThreadView[]
      finalizedChapters: FinalizedChapter[]
      blueprintProposals: SelectableBlueprintProposal[]
    }

function displayValue(value: unknown, locale: string): string {
  if (Array.isArray(value)) return value.join(locale === 'zh-CN' ? '、' : ', ')
  if (value === undefined || value === null || value === '') return '—'
  return String(value)
}

function buildSelectableProposals(
  args: Record<string, unknown>,
  unwrittenBlueprints: BlueprintData[],
): SelectableBlueprintProposal[] {
  if (!Array.isArray(args.blueprint_changes)) return []
  const byChapter = new Map(unwrittenBlueprints.map(blueprint => [blueprint.chapterNumber, blueprint]))
  const proposals = new Map<string, SelectableBlueprintProposal>()
  for (const candidate of args.blueprint_changes) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const value = candidate as Record<string, unknown>
    const chapterNumber = value.chapter_number
    if (!Number.isInteger(chapterNumber)) continue
    const blueprint = byChapter.get(chapterNumber as number)
    if (!blueprint) continue
    const proposal = buildChapterBlueprintProposal(value, blueprint)
    if (!proposal.valid) continue
    for (const diff of proposal.diffs) {
      if (JSON.stringify(diff.current) === JSON.stringify(diff.proposed)) continue
      const key = `${chapterNumber}:${diff.field}`
      proposals.set(key, {
        key,
        name: 'propose_chapter_blueprint',
        arguments: { chapter_number: chapterNumber, changes: { [diff.field]: diff.proposed } },
        chapterNumber: chapterNumber as number,
        chapterTitle: blueprint.title,
        field: diff.field,
        current: diff.current,
        proposed: diff.proposed,
      })
    }
  }
  return [...proposals.values()]
}

export function buildConfigImpactPreview(
  args: Record<string, unknown>,
  changedFields: string[],
  blueprints: BlueprintData[],
  drafts: DraftMeta[],
  threads: NarrativeThreadView[],
): Extract<ConfigImpactPreviewState, { kind: 'valid' }> {
  const finalizedByChapter = new Map<number, FinalizedChapter>()
  const writtenChapters = new Set<number>()
  for (const draft of drafts) {
    writtenChapters.add(draft.chapterNumber)
    if (draft.status !== 'finalized' || finalizedByChapter.has(draft.chapterNumber)) continue
    finalizedByChapter.set(draft.chapterNumber, {
      chapterNumber: draft.chapterNumber,
      title: draft.chapterTitle?.trim() || `#${draft.chapterNumber}`,
    })
  }
  const unwritten = blueprints
    .filter(blueprint => !writtenChapters.has(blueprint.chapterNumber))
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  return {
    kind: 'valid',
    changedFields,
    unwrittenBlueprints: unwritten.map(blueprint => ({
      chapterNumber: blueprint.chapterNumber,
      title: blueprint.title,
    })),
    activeThreads: threads.filter(thread => thread.status !== 'resolved' && thread.status !== 'abandoned'),
    finalizedChapters: [...finalizedByChapter.values()].sort((left, right) => left.chapterNumber - right.chapterNumber),
    blueprintProposals: buildSelectableProposals(args, unwritten),
  }
}

export function useConfigImpactPreview(
  toolCall: ToolCallInfo,
  proposalPreview: DomainProposalPreview,
): ConfigImpactPreviewState {
  const currentProject = useProjectStore(state => state.currentProject)
  const changedFields = useMemo(() => proposalPreview.diffs
    .map(diff => diff.field)
    .filter(field => STORY_FACT_FIELDS.has(field)), [proposalPreview.diffs])
  const immediate = useMemo<ConfigImpactPreviewState | null>(() => {
    if (toolCall.toolName !== 'propose_novel_config' || changedFields.length === 0) {
      return { kind: 'none', changedFields }
    }
    if (proposalPreview.kind !== 'valid' || !currentProject || !toolCall.projectSession
      || !sameProjectSessionContext(toolCall.projectSession, projectSessionContextFromProject(currentProject))) {
      return { kind: 'stale', changedFields }
    }
    return null
  }, [changedFields, currentProject, proposalPreview.kind, toolCall.projectSession, toolCall.toolName])
  const requestKey = useMemo(() => JSON.stringify({
    toolCallId: toolCall.id,
    args: toolCall.arguments,
    changedFields,
    projectSession: toolCall.projectSession,
  }), [changedFields, toolCall.arguments, toolCall.id, toolCall.projectSession])
  const [loaded, setLoaded] = useState<{ key: string; preview: ConfigImpactPreviewState } | null>(null)

  useEffect(() => {
    if (immediate || !currentProject || !toolCall.projectSession) return
    let disposed = false
    void Promise.all([
      ipc.invokeWithProjectSession(toolCall.projectSession, 'db:blueprint-get-all', currentProject.path),
      ipc.invokeWithProjectSession(toolCall.projectSession, 'db:draft-list-all', currentProject.path),
      ipc.invokeWithProjectSession(toolCall.projectSession, 'db:narrative-thread-list', currentProject.path),
    ]).then(([blueprints, drafts, threads]) => {
      if (disposed) return
      const now = useProjectStore.getState().currentProject
      if (!sameProjectSessionContext(toolCall.projectSession, projectSessionContextFromProject(now))) {
        setLoaded({ key: requestKey, preview: { kind: 'stale', changedFields } })
        return
      }
      setLoaded({
        key: requestKey,
        preview: buildConfigImpactPreview(toolCall.arguments, changedFields, blueprints, drafts, threads),
      })
    }).catch(() => {
      if (!disposed) setLoaded({
        key: requestKey,
        preview: { kind: 'invalid', changedFields, error: 'impact_read_failed' },
      })
    })
    return () => { disposed = true }
  }, [changedFields, currentProject, immediate, requestKey, toolCall.arguments, toolCall.projectSession])

  if (immediate) return immediate
  return loaded?.key === requestKey ? loaded.preview : { kind: 'loading', changedFields }
}

interface Props {
  preview: ConfigImpactPreviewState
  selectedKeys: ReadonlySet<string>
  onSelectionChange: (key: string, selected: boolean) => void
}

export default function ConfigImpactPreview({ preview, selectedKeys, onSelectionChange }: Props) {
  const text = useLocaleStore(state => state.text)
  const locale = useLocaleStore(state => state.locale)
  if (preview.kind === 'none') return null
  if (preview.kind === 'loading') {
    return <div className="mt-2 text-xs opacity-70">{text('正在分析潜在影响…', 'Analyzing potential impact…')}</div>
  }
  if (preview.kind === 'stale') {
    return <div className="mt-2 text-xs text-[var(--color-error-text)]">{text('项目已切换，影响预览已失效。', 'The project changed. This impact preview is stale.')}</div>
  }
  if (preview.kind === 'invalid') {
    return <div className="mt-2 text-xs text-[var(--color-error-text)]">{text('无法读取影响预览，请重试。', 'The impact preview could not be loaded. Please retry.')}</div>
  }
  const changedLabels = preview.changedFields.map(field => text(
    CONFIG_LABELS[field]?.[0] ?? field,
    CONFIG_LABELS[field]?.[1] ?? field,
  )).join(text('、', ', '))
  return (
    <section className="mt-3 space-y-2 rounded border border-[var(--color-border)] p-2" aria-label={text('潜在影响', 'Potential impact')}>
      <div className="text-xs font-semibold">{text('潜在影响', 'Potential impact')}</div>
      <div className="text-[0.68rem] opacity-75">
        {text(
          `以下项目可能受“${changedLabels}”影响；此预览不会写入项目。`,
          `These items may be affected by “${changedLabels}”. This preview is not saved.`,
        )}
      </div>

      <ImpactList
        title={text('未写章节蓝图', 'Unwritten blueprints')}
        empty={text('没有未写蓝图', 'No unwritten blueprints')}
        items={preview.unwrittenBlueprints.map(item => ({
          key: `blueprint:${item.chapterNumber}`,
          title: text(`第 ${item.chapterNumber} 章 · ${item.title}`, `Chapter ${item.chapterNumber} · ${item.title}`),
          reason: text('可能需要与更新后的故事事实重新对齐', 'May need alignment with the updated story facts'),
        }))}
      />
      <ImpactList
        title={text('活跃叙事线索', 'Active narrative threads')}
        empty={text('没有活跃线索', 'No active narrative threads')}
        items={preview.activeThreads.map(thread => ({
          key: `thread:${thread.id}`,
          title: thread.title,
          reason: text('作者意图可能依赖当前配置；线索计划不会被修改', 'Its author intent may depend on the current config; the plan will not be changed'),
        }))}
      />
      <ImpactList
        title={text('已定稿章节（只读）', 'Finalized chapters (read only)')}
        empty={text('没有已定稿章节', 'No finalized chapters')}
        items={preview.finalizedChapters.map(chapter => ({
          key: `finalized:${chapter.chapterNumber}`,
          title: text(`第 ${chapter.chapterNumber} 章 · ${chapter.title}`, `Chapter ${chapter.chapterNumber} · ${chapter.title}`),
          reason: text('仅提示潜在矛盾，正文绝不自动改写', 'Potential conflicts are shown only; finalized prose is never rewritten'),
        }))}
      />

      {preview.blueprintProposals.length > 0 && (
        <div className="space-y-1" aria-label={text('可选蓝图差异', 'Optional blueprint changes')}>
          <div className="text-[0.7rem] font-medium">{text('可选蓝图差异（将逐项再次确认）', 'Optional blueprint changes (confirmed again one by one)')}</div>
          {preview.blueprintProposals.map(proposal => (
            <label key={proposal.key} className="flex cursor-pointer items-start gap-2 rounded bg-[var(--color-hover)] p-2 text-[0.68rem]">
              <input
                type="checkbox"
                checked={selectedKeys.has(proposal.key)}
                onChange={event => onSelectionChange(proposal.key, event.currentTarget.checked)}
                aria-label={text(
                  `第 ${proposal.chapterNumber} 章 ${BLUEPRINT_LABELS[proposal.field]?.[0] ?? proposal.field}`,
                  `Chapter ${proposal.chapterNumber} ${BLUEPRINT_LABELS[proposal.field]?.[1] ?? proposal.field}`,
                )}
              />
              <span>
                <span className="font-medium">{text(`第 ${proposal.chapterNumber} 章`, `Chapter ${proposal.chapterNumber}`)} · {proposal.chapterTitle} · {text(
                  BLUEPRINT_LABELS[proposal.field]?.[0] ?? proposal.field,
                  BLUEPRINT_LABELS[proposal.field]?.[1] ?? proposal.field,
                )}</span>
                <span className="mt-1 block opacity-75">
                  {text('当前：', 'Current: ')}{displayValue(proposal.current, locale)}
                  {' '}
                  {text('建议：', 'Proposed: ')}{displayValue(proposal.proposed, locale)}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </section>
  )
}

function ImpactList({ title, empty, items }: {
  title: string
  empty: string
  items: Array<{ key: string; title: string; reason: string }>
}) {
  return (
    <div className="space-y-1">
      <div className="text-[0.7rem] font-medium">{title}</div>
      {items.length === 0
        ? <div className="text-[0.68rem] opacity-60">{empty}</div>
        : items.map(item => (
            <div key={item.key} className="rounded bg-[var(--color-hover)] px-2 py-1 text-[0.68rem]">
              <div>{item.title}</div>
              <div className="opacity-65">{item.reason}</div>
            </div>
          ))}
    </div>
  )
}
