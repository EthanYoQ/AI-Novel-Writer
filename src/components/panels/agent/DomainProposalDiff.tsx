/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState } from 'react'

import type { ToolCallInfo } from '../../../services/agent/agent-engine'
import { ipc } from '../../../services/ipc-client'
import { buildChapterBlueprintProposal } from '../../../services/agent/tools/propose-chapter-blueprint.tool'
import { buildNovelConfigProposal, type ProposalFieldDiff } from '../../../services/agent/tools/propose-novel-config.tool'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'

export const CONFIG_LABELS: Record<string, readonly [string, string]> = {
  genre: ['类型', 'Genre'], subGenre: ['子类型', 'Subgenre'], targetAudience: ['目标读者', 'Target audience'],
  totalChapters: ['总章节数', 'Total chapters'], wordsPerChapter: ['每章字数', 'Words per chapter'],
  plotStructure: ['情节结构', 'Plot structure'], narrativePOV: ['叙事视角', 'Narrative POV'],
  coreOutline: ['核心大纲', 'Core outline'], worldSetting: ['世界设定', 'World setting'],
  goldenFinger: ['金手指', 'Special advantage'], protagonistProfile: ['主角设定', 'Protagonist profile'],
  globalGuidance: ['全局指导', 'Global guidance'], writingStyle: ['写作风格', 'Writing style'],
  referenceWorks: ['参考作品', 'Reference works'], writingLanguage: ['写作语言', 'Writing language'],
}
export const BLUEPRINT_LABELS: Record<string, readonly [string, string]> = {
  title: ['章节标题', 'Chapter title'], role: ['章节定位', 'Chapter role'], purpose: ['章节目的', 'Purpose'],
  keyEvents: ['关键事件', 'Key events'], characters: ['出场角色', 'Characters'], suspenseHook: ['悬念钩子', 'Suspense hook'],
  userGuidance: ['作者指导', 'Author guidance'], notes: ['备注', 'Notes'],
}

export interface DomainProposalPreview {
  kind: 'none' | 'loading' | 'valid' | 'invalid' | 'stale'
  diffs: ProposalFieldDiff[]
  error?: string
}

function displayValue(value: unknown, locale: string): string {
  if (Array.isArray(value)) return value.join(locale === 'zh-CN' ? '、' : ', ')
  if (value === undefined || value === null || value === '') return '—'
  return String(value)
}

export function useDomainProposalPreview(toolCall: ToolCallInfo): DomainProposalPreview {
  const currentProject = useProjectStore(s => s.currentProject)
  const [blueprintPreview, setBlueprintPreview] = useState<DomainProposalPreview>({ kind: 'loading', diffs: [] })
  const isConfig = toolCall.toolName === 'propose_novel_config'
  const isBlueprint = toolCall.toolName === 'propose_chapter_blueprint'
  const sessionCurrent = !!toolCall.projectSession && sameProjectSessionContext(
    toolCall.projectSession,
    projectSessionContextFromProject(currentProject),
  )

  const configPreview = useMemo<DomainProposalPreview>(() => {
    if (!isConfig) return { kind: 'none', diffs: [] }
    if (!currentProject || !sessionCurrent) return { kind: 'stale', diffs: [] }
    const proposal = buildNovelConfigProposal(toolCall.arguments, currentProject.novelConfig)
    return proposal.valid
      ? { kind: 'valid', diffs: proposal.diffs }
      : { kind: 'invalid', diffs: [], error: proposal.error }
  }, [currentProject, isConfig, sessionCurrent, toolCall.arguments])

  const blueprintImmediate = useMemo<DomainProposalPreview | null>(() => {
    if (!isBlueprint) return { kind: 'none', diffs: [] }
    if (!currentProject || !sessionCurrent || !toolCall.projectSession) return { kind: 'stale', diffs: [] }
    const chapterNumber = toolCall.arguments.chapter_number
    if (!Number.isInteger(chapterNumber) || (chapterNumber as number) <= 0) {
      return { kind: 'invalid', diffs: [], error: '章节号无效' }
    }
    return null
  }, [currentProject, isBlueprint, sessionCurrent, toolCall.arguments, toolCall.projectSession])

  useEffect(() => {
    if (blueprintImmediate || !currentProject || !toolCall.projectSession) return
    const chapterNumber = toolCall.arguments.chapter_number
    let disposed = false
    void ipc.invokeWithProjectSession(
      toolCall.projectSession, 'db:blueprint-get', chapterNumber as number, currentProject.path,
    ).then((blueprint) => {
      if (disposed) return
      const now = useProjectStore.getState().currentProject
      if (!sameProjectSessionContext(toolCall.projectSession, projectSessionContextFromProject(now))) {
        setBlueprintPreview({ kind: 'stale', diffs: [] })
        return
      }
      if (!blueprint) {
        setBlueprintPreview({ kind: 'invalid', diffs: [], error: `第 ${chapterNumber} 章蓝图不存在` })
        return
      }
      const proposal = buildChapterBlueprintProposal(toolCall.arguments, blueprint)
      setBlueprintPreview(proposal.valid
        ? { kind: 'valid', diffs: proposal.diffs }
        : { kind: 'invalid', diffs: [], error: proposal.error })
    }).catch(() => {
      if (!disposed) setBlueprintPreview({ kind: 'invalid', diffs: [], error: '无法读取章节蓝图' })
    })
    return () => { disposed = true }
  }, [blueprintImmediate, currentProject, toolCall.arguments, toolCall.projectSession])

  return isConfig ? configPreview : blueprintImmediate ?? blueprintPreview
}

export default function DomainProposalDiff({ toolCall, preview }: { toolCall: ToolCallInfo; preview: DomainProposalPreview }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  if (preview.kind === 'none') return null
  if (preview.kind === 'loading') return <div className="text-xs opacity-70">{text('正在读取当前值…', 'Loading current values…')}</div>
  if (preview.kind === 'stale') return <div className="text-xs text-[var(--color-error-text)]">{text('项目已切换，此提案已过期，不会写入。', 'The project changed. This proposal is stale and will not be written.')}</div>
  if (preview.kind === 'invalid') return <div className="text-xs text-[var(--color-error-text)]">{text(`提案无效：${preview.error ?? '未知错误'}`, 'Invalid proposal fields or target.')}</div>
  const labels = toolCall.toolName === 'propose_novel_config' ? CONFIG_LABELS : BLUEPRINT_LABELS
  return (
    <div className="space-y-2" aria-label={text('字段变更', 'Field changes')}>
      {preview.diffs.map(diff => (
        <div key={diff.field} className="rounded border border-[var(--color-border)] p-2">
          <div className="mb-1 text-xs font-medium">{text(labels[diff.field]?.[0] ?? diff.field, labels[diff.field]?.[1] ?? diff.field)}</div>
          <div className="grid grid-cols-2 items-start gap-2 text-[0.7rem]">
            <div><span className="opacity-60">{text('当前', 'Current')}</span><div className="whitespace-pre-wrap break-words">{displayValue(diff.current, locale)}</div></div>
            <div><span className="opacity-60">{text('建议', 'Proposed')}</span><div className="whitespace-pre-wrap break-words">{displayValue(diff.proposed, locale)}</div></div>
          </div>
        </div>
      ))}
    </div>
  )
}
