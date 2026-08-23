// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  NovelPluginCardBody,
  NovelWorkbenchBody,
  NovelV2WorkbenchBody,
  type NovelWorkbenchBodyProps,
  type NovelV2WorkbenchBodyProps,
} from '../src/client/workbench-view.tsx'
import type { NovelWorkbenchState } from '../src/client/workbench-store.ts'
import type { NovelProjectId, Revision } from '../src/types.ts'
import type { NovelV2WorkbenchState } from '../src/client/workbench-v2.ts'
import { novelContextCss } from '../src/client/setup-style.ts'

const uninitialized: NovelWorkbenchState = {
  status: 'not-initialized',
  open: true,
  initialization: {
    phase: 'editing',
    draft: {
      title: '', language: 'zh-CN', genre: '', plannedChapters: '20',
      targetWordsPerChapter: '3000', creativeStrategy: 'auto',
    },
  },
}

const v2Ready = {
  status: 'ready', open: false,
  workspace: {
    workspaceId: 'workspace-v2' as never,
    project: {
      revision: 1, title: '潮汐来信', language: 'zh-CN', genre: '悬疑', plannedChapters: 12, targetWordsPerChapter: 3000,
      creativeStrategy: 'auto', structureMode: 'three-act', narrativePov: 'third-limited', globalGuidance: '',
      createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
    },
    globalRevision: 1, readOnly: false, snapshot: {} as never,
  },
  proposals: { phase: 'ready', items: [], selectedId: undefined, selectedChange: undefined, message: undefined },
  tasks: { items: [], selectedId: undefined, message: undefined }, chapters: { selected: undefined, items: [] },
  authoring: {
    stage: undefined, brief: '', input: undefined, phase: 'idle', message: undefined, chapter: undefined,
    selectedArtifactId: undefined, selectedFinalArtifactId: undefined,
  },
} satisfies Extract<NovelV2WorkbenchState, { status: 'ready' }>

const editorActions: Omit<NovelWorkbenchBodyProps, 'state'> = {
  backIcon: <span aria-hidden="true" data-icon="chevron-left" />,
  refresh: vi.fn(), selectChapter: vi.fn(), updateInitialization: vi.fn(),
  updateInitializationGenerationBrief: vi.fn(), generateInitialization: vi.fn(),
  previewInitialization: vi.fn(), submitInitialization: vi.fn(), openAsset: vi.fn(),
  backToAssets: vi.fn(), updateProjectSettings: vi.fn(), updateAssetSummary: vi.fn(),
  updateAssetGenerationBrief: vi.fn(), generateAsset: vi.fn(),
  previewAssetChange: vi.fn(), submitAssetChange: vi.fn(), discardAssetChanges: vi.fn(),
  reloadStaleAsset: vi.fn(), setCharacterSearch: vi.fn(), selectCharacter: vi.fn(),
  createCharacter: vi.fn(), updateCharacter: vi.fn(), deleteCharacter: vi.fn(),
  updateStoryBlueprint: vi.fn(), updateChapterBlueprint: vi.fn(), updateChapterDraft: vi.fn(),
}

const v2Actions: Omit<NovelV2WorkbenchBodyProps, 'state'> = {
  refresh: vi.fn(), selectProposal: vi.fn(), openProposalChange: vi.fn(), applySelectedProposal: vi.fn(),
  retryProposalItem: vi.fn(), discardProposalItem: vi.fn(), regenerateProposalItem: vi.fn(),
  selectTask: vi.fn(), selectChapter: vi.fn(),
  updateDraftBrief: vi.fn(), prepareAuthoring: vi.fn(), startDraft: vi.fn(), updateAuthoringInput: vi.fn(), reproposeManualDraft: vi.fn(),
  selectArtifact: vi.fn(), selectFinal: vi.fn(), updateInitialization: vi.fn(), initializeWorkspace: vi.fn(),
}

function ready(
  screen: Extract<NovelWorkbenchState, { status: 'ready' }>['screen'],
  characters: Extract<NovelWorkbenchState, { status: 'ready' }>['characters'] = [
    { id: 'lin', name: '林澈', role: '调查者', summary: '追查旧案' },
  ],
): NovelWorkbenchState {
  return {
    status: 'ready', open: true, screen,
    project: {
      projectId: '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId,
      title: '潮汐来信', language: 'zh-CN', genre: '悬疑', plannedChapters: 20,
      targetWordsPerChapter: 3000, creativeStrategy: 'auto', updatedAt: '2026-08-16T00:00:00.000Z',
    },
    progress: { selectedChapter: 1, plannedChapters: 20, status: 'unplanned', draftPresent: false, draftBytes: 0 },
    characters,
    storyBlueprint: null, chapterBlueprint: null, draft: null, omittedSources: [],
  }
}

describe('novel workbench presentation', () => {
  it('renders a labeled one-column initialization form and an explicit proposal action', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody
      {...editorActions}
      state={{
        ...uninitialized,
        readFeedback: { kind: 'success', message: '读取完成：当前工作区尚未初始化小说项目。' },
      }}
    />)

    for (const label of ['小说标题', '语言', '类型', '计划章数', '每章目标字数', '创作策略']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('预览初始化提案')
    expect(html).toContain('Harness 原生审批')
    expect(html).toContain('读取完成：当前工作区尚未初始化小说项目。')
    expect(html).not.toContain('批准修改')
    expect(html).not.toContain('dashboard')
  })

  it('shows mounted, Preset, Workspace, and project evidence in Plugin Configuration', () => {
    const html = renderToStaticMarkup(<NovelPluginCardBody
      setupState={{ status: 'installed', open: false, changed: false }}
      workbenchState={uninitialized}
      workbenchMode="v1"
      openWorkbench={vi.fn()}
      refresh={vi.fn()}
    />)

    for (const text of [
      'AI 小说作家', 'Host 已连接', 'Client 已挂载', 'Preset 已安装',
      'Workspace 已选择', '项目未初始化', '打开小说工作台',
    ]) expect(html).toContain(text)
  })

  it('shows the active V2 workbench status instead of V1 project evidence in Plugin Configuration', () => {
    const html = renderToStaticMarkup(<NovelPluginCardBody
      setupState={{ status: 'installed', open: false, changed: false }}
      workbenchState={v2Ready}
      workbenchMode="v2"
      openWorkbench={vi.fn()}
      refresh={vi.fn()}
    />)

    for (const text of ['V2 单列工作台', 'Workspace 已选择', '项目已加载（V2）']) expect(html).toContain(text)
    expect(html).not.toContain('项目未初始化')
  })

  it('keeps V2 project creation to the author’s minimal starting fields', () => {
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      status: 'not-initialized', open: true, workspace: undefined,
      proposals: { phase: 'ready', items: [], selectedId: undefined, selectedChange: undefined, message: undefined },
      tasks: { items: [], selectedId: undefined, message: undefined },
      chapters: { selected: undefined, items: [] },
      authoring: v2Ready.authoring,
      initialization: {
        phase: 'editing', message: undefined,
        draft: {
          title: '', language: 'zh-CN', genre: '', plannedChapters: 12, targetWordsPerChapter: 3_000,
          creativeStrategy: 'auto', structureMode: 'three-act', narrativePov: 'third-limited', globalGuidance: '',
        },
      },
    } as never} />)

    for (const label of ['小说标题', '类型', '计划章数', '每章目标字数']) expect(html).toContain(label)
    for (const label of ['语言', '创作策略', '结构模式', '叙事视角', '全局创作提示', 'Host']) expect(html).not.toContain(label)
    expect(html).toContain('创建项目')
  })

  it('orders the author navigation from project settings through the outline before chapter blueprints', () => {
    document.body.innerHTML = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        snapshot: { chapters: [], artifacts: [], chapterFinals: [], tasks: [] } as never,
      },
    }} />)

    const labels = [...document.querySelectorAll('.aiNovelV2AssetNav button')]
      .map(button => button.textContent)
    expect(labels.slice(0, 4)).toEqual(['项目设置', '故事架构', '人物设定', '全书纲要'])
  })

  it('places the selected prefilled stage before the compact review lane without an extra edit action', () => {
    const architecture = {
      revision: 1, premise: '潮汐退去后收到未来的信', characterGraph: '林澈与弟弟', world: '永夜群岛',
      plotOutline: '全书主线', styleConstraints: '短句', referenceWorks: [],
    }
    document.body.innerHTML = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: { ...v2Ready.workspace, snapshot: { architecture, tasks: [], chapters: [], artifacts: [], chapterFinals: [] } as never },
      authoring: {
        stage: 'architecture', chapter: undefined, brief: '', input: undefined, phase: 'editing', message: undefined,
        selectedArtifactId: undefined, selectedFinalArtifactId: undefined,
      },
    } as never} />)

    const stageShell = document.querySelector('.aiNovelV2StageShell')
    const stageContent = stageShell?.querySelector('.aiNovelV2StageContent')
    const form = stageContent?.querySelector('[aria-label="故事架构创作表单"]')
    const review = stageShell?.querySelector('details.aiNovelV2Review[aria-label="审核建议"]') as HTMLDetailsElement | null
    const premise = form?.querySelector('[aria-label="故事架构故事前提"]') as HTMLTextAreaElement | null

    expect([...stageShell?.children ?? []].map(element => element.className)).toEqual([
      'aiNovelV2StageNav', 'aiNovelV2StageContent', 'aiNovelV2Review',
    ])
    expect(form).not.toBeNull()
    expect(premise?.value).toBe('潮汐退去后收到未来的信')
    expect(form?.querySelector('.aiNovelV2AuthoringActions')).not.toBeNull()
    expect(form?.textContent).not.toContain('编辑故事架构')
    expect(review?.open).toBe(false)
    expect(review?.querySelector('summary')?.textContent).toBe('审核建议（0）')
  })

  it('keeps V2 authoring actions static and exposes the review as the narrow-screen disclosure trigger', () => {
    expect(novelContextCss).toContain('.aiNovelV2AuthoringActions,.aiNovelV2ReviewActions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-start;gap:8px;position:static')
    expect(novelContextCss).toContain('.aiNovelWorkbenchActions{position:sticky')
    expect(novelContextCss).toContain('.aiNovelV2StageShell{grid-template-columns:minmax(0,1fr);gap:14px}')
    expect(novelContextCss).toContain('.aiNovelV2StageNav{order:0}.aiNovelV2StageContent{order:1}.aiNovelV2Review{order:2}')
  })

  it('keeps initialization and project-read failures actionable without source details', () => {
    const initializationFailure = 'Host initialize failed for workspaceId=workspace-private-id'
    const initializationHtml = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      status: 'not-initialized', open: true, workspace: undefined,
      proposals: { phase: 'ready', items: [], selectedId: undefined, selectedChange: undefined, message: undefined },
      tasks: { items: [], selectedId: undefined, message: undefined }, chapters: { selected: undefined, items: [] }, authoring: v2Ready.authoring,
      initialization: {
        phase: 'error', message: initializationFailure,
        draft: {
          title: '', language: 'zh-CN', genre: '', plannedChapters: 12, targetWordsPerChapter: 3_000,
          creativeStrategy: 'auto', structureMode: 'three-act', narrativePov: 'third-limited', globalGuidance: '',
        },
      },
    } as never} />)
    expect(initializationHtml).toContain('项目暂未创建成功。请检查创作起点后重试。')
    expect(initializationHtml).not.toContain(initializationFailure)

    const readFailure = 'Host read failed for artifactId=artifact-private-id'
    const readHtml = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      status: 'error', open: true, workspace: undefined,
      proposals: { phase: 'ready', items: [], selectedId: undefined, selectedChange: undefined, message: undefined },
      tasks: { items: [], selectedId: undefined, message: undefined }, chapters: { selected: undefined, items: [] }, authoring: v2Ready.authoring,
      message: readFailure,
    } as never} />)
    expect(readHtml).toContain('暂时无法读取小说项目。请重试读取。')
    expect(readHtml).not.toContain(readFailure)
  })

  it('renders a project Proposal as field changes while retaining its recovery controls', () => {
    const proposal = {
      proposalId: 'proposal-opaque-id', status: 'failed', items: [{
        itemId: 'proposal-item-opaque-id', itemOrder: 1, status: 'failed', attemptCount: 1,
        failure: '请重新生成这项建议。',
        change: {
          changeSetId: 'project-change-opaque-id', operation: 'replace', aggregate: { kind: 'project' },
          baseAggregateRevision: 1, baseGlobalRevision: 1,
          nextValue: { ...v2Ready.workspace.project, title: '潮汐来信（新标题）', genre: '历史悬疑' },
          provenance: { origin: 'model', sessionId: 'session-opaque-id', callId: 'call-opaque-id', argsHash: 'a'.repeat(64) },
        },
      }],
    }
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        snapshot: { project: v2Ready.workspace.project, artifacts: [], chapterFinals: [], chapters: [] } as never,
      },
      proposals: { phase: 'ready', items: [proposal], selectedId: proposal.proposalId, selectedChange: 0, message: undefined },
    } as never} />)

    for (const text of ['项目设置建议', '小说标题', '当前：潮汐来信', '建议：潮汐来信（新标题）', '类型', '建议：历史悬疑']) {
      expect(html).toContain(text)
    }
    for (const technicalText of ['"title"', 'baseGlobalRevision', '聚合版本', '全局版本', 'Host', '命令差异', 'proposal-opaque-id']) {
      expect(html).not.toContain(technicalText)
    }
    for (const action of ['重试此项', '放弃此项', '重新生成', '依序应用未完成项']) expect(html).toContain(action)
  })

  it('does not disable discarding a pending Proposal because unrelated lifecycle operations are unavailable', () => {
    const proposal = {
      proposalId: 'proposal-pending', status: 'pending', items: [{
        itemId: 'proposal-pending-item', itemOrder: 1, status: 'pending', attemptCount: 0,
        change: {
          changeSetId: 'project-change-pending', operation: 'replace', aggregate: { kind: 'project' },
          baseAggregateRevision: 1, baseGlobalRevision: 1,
          nextValue: { ...v2Ready.workspace.project, title: '待审核标题' },
          provenance: { origin: 'model', sessionId: 'session-pending', callId: 'call-pending', argsHash: 'a'.repeat(64) },
        },
      }],
    }
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        snapshot: { project: v2Ready.workspace.project, artifacts: [], chapterFinals: [], chapters: [] } as never,
      },
      proposals: { phase: 'ready', items: [proposal], selectedId: proposal.proposalId, selectedChange: 0, message: undefined },
    } as never} />)

    expect(html).toContain('<button type="button">放弃此项</button>')
  })

  it('labels applied Proposal receipts from each proposal change target', () => {
    const proposal = {
      proposalId: 'proposal-applied-labels', status: 'applied', items: [
        {
          itemId: 'project-applied-item', itemOrder: 1, status: 'applied', attemptCount: 1,
          change: {
            changeSetId: 'project-applied-change', operation: 'replace', aggregate: { kind: 'project' },
            baseAggregateRevision: 1, baseGlobalRevision: 1,
            nextValue: v2Ready.workspace.project,
            provenance: { origin: 'model', sessionId: 'session-applied', callId: 'call-project', argsHash: 'b'.repeat(64) },
          },
          receipt: {
            changeSetId: 'project-applied-change', projectId: 'project-applied', aggregate: { kind: 'project' },
            aggregateRevision: 2, globalRevision: 2,
          },
        },
        {
          itemId: 'architecture-applied-item', itemOrder: 2, status: 'applied', attemptCount: 1,
          change: {
            changeSetId: 'architecture-applied-change', operation: 'replace', aggregate: { kind: 'architecture' },
            baseAggregateRevision: 0, baseGlobalRevision: 2,
            nextValue: { premise: '潮汐会传递来信。', characterGraph: '', world: '', plotOutline: '', styleConstraints: '', referenceWorks: [] },
            provenance: { origin: 'model', sessionId: 'session-applied', callId: 'call-architecture', argsHash: 'c'.repeat(64) },
          },
          receipt: {
            changeSetId: 'architecture-applied-change', projectId: 'project-applied', aggregate: { kind: 'architecture' },
            aggregateRevision: 1, globalRevision: 3,
          },
        },
        {
          itemId: 'draft-applied-item', itemOrder: 3, status: 'applied', attemptCount: 1,
          change: { kind: 'artifact/draft', artifactId: 'draft-applied', chapter: 1, content: '# 初稿', summary: '第一章初稿' },
          receipt: { kind: 'artifact/draft', artifactId: 'draft-applied', chapter: 1 },
        },
      ],
    }
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        snapshot: { project: v2Ready.workspace.project, artifacts: [], chapterFinals: [], chapters: [] } as never,
      },
      proposals: { phase: 'ready', items: [proposal], selectedId: proposal.proposalId, selectedChange: undefined, message: undefined },
    } as never} />)

    expect(html).toContain('项目设置已应用。')
    expect(html).toContain('故事架构已应用。')
    expect(html).toContain('第 1 章建议已应用。')
  })

  it('does not expose an internal task identity in a task Proposal label', () => {
    const proposal = {
      proposalId: 'proposal-task', status: 'pending', items: [{
        itemId: 'proposal-task-item', itemOrder: 1, status: 'pending', attemptCount: 0,
        change: {
          changeSetId: 'task-change', operation: 'replace', aggregate: { kind: 'task', taskId: 'internal-task-42' },
          baseAggregateRevision: 0, baseGlobalRevision: 1,
          nextValue: { taskId: 'internal-task-42', kind: 'architecture', stage: 'continuity-check', chapter: 1, status: 'pending' },
          provenance: { origin: 'model', sessionId: 'session', callId: 'call', argsHash: 'b'.repeat(64) },
        },
      }],
    }
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: { ...v2Ready.workspace, snapshot: { tasks: [] } as never },
      proposals: { phase: 'ready', items: [proposal], selectedId: proposal.proposalId, selectedChange: 0, message: undefined },
    } as never} />)

    expect(html).toContain('创作任务建议')
    for (const text of ['任务类型', '架构设计', '当前环节', '连续性检查', '任务状态', '等待']) expect(html).toContain(text)
    expect(html).not.toContain('internal-task-42')
    expect(html).not.toContain('continuity-check')
  })

  it('renders chapter Proposal people, lifecycle, and failures in author language', () => {
    const chapter = {
      revision: 1, chapter: 1, title: '退潮来信', purpose: '收到未来来信', plotBeats: [], characters: [], keyEvents: [], suspense: '', status: 'drafting' as const,
    }
    const proposal = {
      proposalId: 'proposal-private-id', status: 'failed', items: [{
        itemId: 'proposal-item-private-id', itemOrder: 1, status: 'failed', attemptCount: 1,
        failure: 'Host rejected artifactId=artifact-private-id for characterId=character-private-id',
        change: {
          changeSetId: 'chapter-change-private-id', operation: 'replace', aggregate: { kind: 'chapter', chapter: 1 },
          baseAggregateRevision: 1, baseGlobalRevision: 1,
          nextValue: { ...chapter, characters: ['character-private-id'] },
          provenance: { origin: 'model', sessionId: 'session-private-id', callId: 'call-private-id', argsHash: 'c'.repeat(64) },
        },
      }],
    }
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        snapshot: {
          chapters: [chapter],
          characters: {
            revision: 1,
            items: [{ characterId: 'character-private-id', name: '林澈', role: '调查者', summary: '追查旧案', goal: '', currentState: '', notes: '' }],
            relationships: [],
          },
          artifacts: [], chapterFinals: [],
        } as never,
      },
      proposals: {
        phase: 'ready', items: [proposal], selectedId: proposal.proposalId, selectedChange: 0,
        message: 'Host proposal/list failed for artifactId=artifact-private-id',
      },
      tasks: {
        selectedId: undefined, message: 'Host task/list failed for taskId=task-private-id',
        items: [{ taskId: 'task-private-id', kind: 'chapter', stage: 'drafting', status: 'failed', failure: 'internal taskId=task-private-id', resumeCursor: 'resume-private-id' }],
      },
      chapters: {
        selected: 1, items: [chapter],
        context: { phase: 'failed', chapter: 1, previousFinal: undefined, message: 'Host context failed for artifactId=artifact-private-id' },
      },
      authoring: {
        stage: 'draft', chapter: 1, brief: '', input: undefined, phase: 'error',
        message: 'session-private-id: Host returned an internal error for artifactId=artifact-private-id',
        selectedArtifactId: undefined, selectedFinalArtifactId: undefined,
      },
    } as never} />)

    for (const text of [
      '出场人物', '建议：林澈', '状态</dt><dd>起草中',
      '这项建议暂时未能完成。请重试、放弃或重新生成。',
      '暂时无法读取提案队列。请稍后重试。', '暂时无法读取创作任务。请稍后重试。',
      '这项创作任务暂未完成。请稍后重新开始。', '这次创作请求暂时未完成。请稍后重试。',
      '上一章定稿暂时无法读取。请重新选择本章后重试。',
    ]) expect(html).toContain(text)
    for (const technicalText of [
      'character-private-id', 'artifact-private-id', 'task-private-id', 'session-private-id',
      'Host', 'artifactId', 'taskId', 'drafting', 'resume-private-id',
    ]) expect(html).not.toContain(technicalText)
  })

  it('renders task progress and resumability in author language', () => {
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: { ...v2Ready.workspace, snapshot: { tasks: [] } as never },
      tasks: {
        selectedId: undefined, message: undefined,
        items: [{ taskId: 'internal-task-42', kind: 'review', stage: 'continuity-check', status: 'blocked', failure: '', resumeCursor: 'opaque-host-marker' }],
      },
    } as never} />)

    for (const text of ['审稿 · 阻塞', '当前环节：连续性检查', '可继续处理这项创作任务。']) expect(html).toContain(text)
    for (const technicalText of ['internal-task-42', 'continuity-check', 'opaque-host-marker', 'Host']) expect(html).not.toContain(technicalText)
  })

  it('shows the controlled duplicate queued request as a retryable author instruction', () => {
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: { ...v2Ready.workspace, snapshot: { project: v2Ready.workspace.project } as never },
      authoring: {
        stage: 'project-refine', chapter: undefined, brief: '保留信件线索。', input: undefined, phase: 'error',
        message: '相同创作请求正在等待处理，请等待完成后再试。',
        selectedArtifactId: undefined, selectedFinalArtifactId: undefined,
      },
    }} />)

    expect(html).toContain('相同创作请求正在等待处理，请等待完成后再试。')

    const failure = 'session-private-id: Host prompt failed for artifactId=artifact-private-id'
    const failureHtml = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: { ...v2Ready.workspace, snapshot: { project: v2Ready.workspace.project } as never },
      authoring: {
        stage: 'project-refine', chapter: undefined, brief: '保留信件线索。', input: undefined, phase: 'error', message: failure,
        selectedArtifactId: undefined, selectedFinalArtifactId: undefined,
      },
    }} />)

    expect(failureHtml).toContain('这次创作请求暂时未完成。请稍后重试。')
    expect(failureHtml).not.toContain(failure)
    expect(failureHtml).not.toContain('session-private-id')
    expect(failureHtml).not.toContain('artifact-private-id')
  })

  it('renders the V2 chapter-authoring form without reopening the raw aggregate editor', () => {
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        snapshot: {
          artifacts: [
            {
              artifactId: 'draft-1', chapter: 1, kind: 'draft', content: '# 退潮来信', summary: '第一章初稿',
              createdAt: '2026-08-21T00:00:00.000Z',
            },
            {
              artifactId: 'revision-1', chapter: 1, kind: 'revision', parentArtifactId: 'draft-1', content: '# 退潮来信（修订）', summary: '第一章修订稿',
              createdAt: '2026-08-21T00:01:00.000Z',
            },
          ],
          chapterFinals: [],
        } as never,
      },
      chapters: {
        selected: 1,
        items: [{ chapter: 1, title: '退潮来信', purpose: '收到来自未来的信。', status: 'drafting', plotBeats: [], keyEvents: [] }],
      },
      authoring: {
        stage: 'revision', brief: '让线索更紧张。', input: { kind: 'prose', content: '# 退潮来信（手改）' }, phase: 'editing',
        selectedArtifactId: 'revision-1', selectedFinalArtifactId: 'revision-1', message: '请选择版本并提交 Proposal。',
      },
    } as never} />)

    for (const text of [
      '创作阶段：修订版本', '起草要求（可选）', '让 AI 起草第 1 章', '手动修改正文',
      '将手动修改重新提交为 Proposal', '提案队列', '选择修订稿',
      '让 AI 修订所选稿件', '已选为定稿候选', '提交定稿建议',
    ]) expect(html).toContain(text)
    expect(html).not.toContain('JSON 草稿')
    expect(html).not.toContain('编辑 / 差异 / 版本（差异只读）')
    expect(html).not.toContain('当前全局版本')
    expect(html).not.toContain('当前值与提案下一值差异')
    expect(html).not.toContain('保存（命令工作流待接入）')
    expect(html).not.toContain('应用（仅 Proposal Bundle 可应用）')
    for (const technicalText of ['draft-1', 'revision-1', '父版本', '版本链']) expect(html).not.toContain(technicalText)
    for (const authorText of ['本章稿件', '初稿', '修订稿', '第一章初稿', '第一章修订稿']) expect(html).toContain(authorText)
  })

  it('shows AI-generated pending draft prose before its Proposal is applied', () => {
    const pendingContent = '# 退潮来信\n\n林澈在码头收到一封没有寄件人的信。'
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        snapshot: { artifacts: [], chapterFinals: [] } as never,
      },
      chapters: {
        selected: 1,
        items: [{ chapter: 1, title: '退潮来信', purpose: '收到来自未来的信。', status: 'drafting', plotBeats: [], keyEvents: [] }],
      },
      authoring: {
        stage: 'draft', chapter: 1, brief: '', input: { kind: 'prose', content: pendingContent }, phase: 'editing',
        selectedArtifactId: undefined, selectedFinalArtifactId: undefined,
        pendingProposalItem: { proposalId: 'pending-proposal', itemId: 'pending-draft-item' },
        message: 'AI 生成的待审核建议已填入本地草稿；它尚未应用，请在建议队列审核后再应用。',
      },
    } as never} />)

    expect(html).toContain('AI 生成的待审核初稿（未应用）')
    expect(html).toContain(pendingContent)
    expect(html).toContain('这份内容仅来自待审核 Proposal；应用后才会成为可修订的本章稿件。')
    expect(html).toContain('用人工修改替换待审核初稿')
    expect(html).not.toContain('readonly=""')
    expect(html).not.toContain('手动修改正文')
  })

  it('uses author-facing version labels for revision guidance and Proposal targets', () => {
    const artifacts = [
      {
        artifactId: 'draft-private-id', chapter: 1, kind: 'draft', content: '# 初稿', summary: '第一章初稿',
        createdAt: '2026-08-21T00:00:00.000Z',
      },
      {
        artifactId: 'revision-private-id', chapter: 1, kind: 'revision', parentArtifactId: 'draft-private-id', content: '# 修订稿', summary: '第一章修订稿',
        createdAt: '2026-08-21T00:01:00.000Z',
      },
    ]
    const proposal = {
      proposalId: 'proposal-private-id', status: 'pending', items: [
        {
          itemId: 'revision-proposal-private-id', itemOrder: 1, status: 'pending', attemptCount: 0,
          change: { kind: 'artifact/revision', chapter: 1, parentArtifactId: 'draft-private-id', content: '# 建议修订', summary: '补足线索' },
        },
        {
          itemId: 'final-proposal-private-id', itemOrder: 2, status: 'pending', attemptCount: 0,
          change: { kind: 'chapter/select-final', chapter: 1, artifactId: 'revision-private-id', summary: '选择修订稿定稿' },
        },
      ],
    }
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        snapshot: {
          artifacts, chapterFinals: [],
          chapters: [{ chapter: 1, title: '退潮来信', purpose: '收到未来信', plotBeats: [], keyEvents: [], status: 'revising' }],
        } as never,
      },
      chapters: { selected: 1, items: [{ chapter: 1, title: '退潮来信', purpose: '收到未来信', plotBeats: [], keyEvents: [], status: 'revising' }] },
      proposals: { phase: 'ready', items: [proposal], selectedId: proposal.proposalId, selectedChange: 0, message: undefined },
      authoring: {
        stage: 'select-final', chapter: 1, brief: '', input: undefined, phase: 'editing', message: undefined,
        selectedArtifactId: 'revision-private-id', selectedFinalArtifactId: 'revision-private-id',
      },
    } as never} />)

    for (const text of [
      '第 1 个版本：第 1 章初稿', '第 2 个版本：第 1 章修订稿',
      '请根据第 2 个版本提出修订建议；人工将在提案中核对目标版本后再应用。',
      '请根据第 2 个版本提出定稿建议；人工将在提案中核对目标版本后再应用。',
      '目标版本', '第 1 个版本（第 1 章初稿）', '第 2 个版本（第 1 章修订稿）',
    ]) expect(html).toContain(text)
    expect(html).not.toContain('手动修改正文')
    expect(html).not.toContain('将手动修改重新提交为 Proposal')
    expect(html).toContain('选择本章的初稿或修订稿后，才能提交人工修订。')
    for (const internalId of ['draft-private-id', 'revision-private-id', 'proposal-private-id']) expect(html).not.toContain(internalId)
  })

  it('uses typed V2 forms for project, architecture, outline, characters, and chapter blueprints', () => {
    const architecture = {
      revision: 1, premise: '未来的信件', characterGraph: '林澈与弟弟', world: '永夜群岛', plotOutline: '全书主线',
      styleConstraints: '短句', referenceWorks: ['潮汐档案'],
    }
    const characters = {
      revision: 1,
      items: [{ characterId: 'lin', name: '林澈', role: '调查者', summary: '追查旧案', goal: '找到弟弟', currentState: '失联前夜', notes: '惧怕深水' }],
      relationships: [{ fromCharacterId: 'lin', toCharacterId: 'bo', relation: '姐弟', notes: '失联' }],
    }
    const chapter = {
      revision: 1, chapter: 1, title: '退潮来信', purpose: '收到未来信', plotBeats: ['退潮', '信匣'],
      characters: ['lin'], keyEvents: ['收到信件'], suspense: '弟弟求救', status: 'planned' as const,
    }
    const snapshot = { project: v2Ready.workspace.project, architecture, characters, chapters: [chapter], artifacts: [], chapterFinals: [], tasks: [] } as never
    const cases = [
      { stage: 'project-refine', chapter: undefined, title: '项目设置', field: '小说标题' },
      { stage: 'architecture', chapter: undefined, title: '故事架构', field: '故事前提' },
      { stage: 'outline', chapter: undefined, title: '全书纲要', field: '全书纲要' },
      { stage: 'characters', chapter: undefined, title: '人物设定', field: '人物 1：姓名' },
      { stage: 'chapter-blueprint', chapter: 1, title: '第 1 章蓝图', field: '章节标题' },
    ] as const

    for (const formCase of cases) {
      const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
        ...v2Ready,
        workspace: { ...v2Ready.workspace, snapshot },
        chapters: { selected: 1, items: [chapter] },
        authoring: {
          stage: formCase.stage, chapter: formCase.chapter, brief: '', input: undefined, phase: 'editing', message: undefined,
          selectedArtifactId: undefined, selectedFinalArtifactId: undefined,
        },
      } as never} />)

      expect(html).toContain(formCase.title)
      expect(html).toContain(formCase.field)
      expect(html).toContain(`让 AI 起草${formCase.title}`)
      expect(html).toContain('将人工修改重新提交为 Proposal')
      expect(html).not.toContain('JSON 草稿')
      if (formCase.stage === 'characters' || formCase.stage === 'chapter-blueprint') {
        for (const technicalText of ['lin', 'bo', 'ID']) expect(html).not.toContain(technicalText)
      }
      if (formCase.stage === 'characters') {
        expect(html).toContain('林澈 | 未命名人物 | 姐弟 | 失联')
      }
      if (formCase.stage === 'chapter-blueprint') {
        expect(html).toContain('出场人物（每行一项）')
        expect(html).toContain('>林澈</textarea>')
        expect(html).not.toContain('手动修改正文')
        expect(html).not.toContain('将手动修改重新提交为 Proposal')
        expect(html).toContain('选择本章的初稿或修订稿后，才能提交人工修订。')
      }
      if (formCase.stage === 'architecture') {
        const container = document.createElement('div')
        container.innerHTML = html
        expect(container.querySelector('[aria-label="故事架构创作表单"]')?.textContent).not.toContain('全书纲要')
      }
    }
  })

  it('renders locally hydrated first-character Proposal fields before they are applied', () => {
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        snapshot: {
          characters: { revision: 0, items: [], relationships: [] },
          artifacts: [], chapterFinals: [], chapters: [], tasks: [],
        } as never,
      },
      authoring: {
        stage: 'characters', chapter: undefined, brief: '', phase: 'editing',
        input: {
          kind: 'structured', stage: 'characters', chapter: undefined,
          values: {
            'character-0-name': '苏晚', 'character-0-role': '旧港档案员',
            'character-0-summary': '保管失踪者留下的录音。', 'character-0-goal': '找回姐姐。',
            'character-0-currentState': '隐瞒录音来源。', 'character-0-notes': '害怕涨潮。', relationships: '',
          },
        },
        selectedArtifactId: undefined, selectedFinalArtifactId: undefined, message: undefined,
      },
    } as never} />)
    const container = document.createElement('div')
    container.innerHTML = html

    expect(container.querySelector<HTMLInputElement>('[aria-label="人物设定人物 1：姓名"]')?.value).toBe('苏晚')
    expect(container.querySelector<HTMLInputElement>('[aria-label="人物设定人物 1：角色"]')?.value).toBe('旧港档案员')
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="人物设定人物 1：简介"]')?.value).toBe('保管失踪者留下的录音。')
    expect(container.querySelector('[aria-label="人物设定人物（每行：姓名 | 角色 | 简介）"]')).toBeNull()
  })

  it('offers the first missing planned chapter as a Proposal-only blueprint placeholder', () => {
    document.body.innerHTML = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        project: { ...v2Ready.workspace.project, plannedChapters: 3 },
        snapshot: { chapters: [], artifacts: [], chapterFinals: [] } as never,
      },
      chapters: { selected: 1, items: [] },
      authoring: {
        stage: 'chapter-blueprint', chapter: 1, brief: '', input: undefined, phase: 'editing', message: undefined,
        selectedArtifactId: undefined, selectedFinalArtifactId: undefined,
      },
    } as never} />)

    expect(document.body.textContent).toContain('创建下一章蓝图（第 1 章）')
    expect(document.body.textContent).toContain('第 1 章蓝图（待创建）')
    expect(document.body.textContent).toContain('这是下一章的创作准备')
    expect(document.body.textContent).toContain('不会直接创建章节或改写现有稿件')
    expect(document.body.textContent?.match(/创建下一章蓝图/g)).toHaveLength(1)
    expect([...document.querySelectorAll('button')].find(button => button.textContent === '让 AI 起草第 1 章蓝图')?.disabled).toBe(false)
    expect(document.querySelector('[aria-label="版本链"]')).toBeNull()
  })

  it.each(['submitted', 'reconciling'] as const)('disables every V2 authoring control while phase is %s', phase => {
    document.body.innerHTML = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: { ...v2Ready.workspace, snapshot: { project: v2Ready.workspace.project } as never },
      authoring: {
        stage: 'project-refine', chapter: undefined, brief: '', input: { kind: 'structured', stage: 'project-refine', chapter: undefined, values: { kind: 'manual' } }, phase, message: undefined,
        selectedArtifactId: undefined, selectedFinalArtifactId: undefined,
      },
    } as never} />)
    for (const label of ['让 AI 起草项目设置', '将人工修改重新提交为 Proposal']) {
      expect([...document.querySelectorAll('button')].find(button => button.textContent === label)?.disabled).toBe(true)
    }

    const chapter = {
      chapter: 1, title: '退潮来信', purpose: '收到未来信', plotBeats: [], keyEvents: [], status: 'revising' as const,
    }
    document.body.innerHTML = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions} state={{
      ...v2Ready,
      workspace: {
        ...v2Ready.workspace,
        snapshot: {
          chapters: [chapter],
          artifacts: [{
            artifactId: 'revision-1', chapter: 1, kind: 'revision', parentArtifactId: 'draft-1', content: '# 修订', summary: '修订稿',
            createdAt: '2026-08-21T00:01:00.000Z',
          }],
          chapterFinals: [],
        } as never,
      },
      chapters: { selected: 1, items: [chapter] },
      authoring: {
        stage: 'revision', chapter: 1, brief: '', input: { kind: 'prose', content: '# 手动修订' }, phase, message: undefined,
        selectedArtifactId: 'revision-1', selectedFinalArtifactId: 'revision-1',
      },
    } as never} />)
    for (const label of ['让 AI 起草第 1 章', '将手动修改重新提交为 Proposal', '让 AI 修订所选稿件', '提交定稿建议']) {
      expect([...document.querySelectorAll('button')].find(button => button.textContent === label)?.disabled).toBe(true)
    }
  })

  it('shows the controller gate and disables structured, chapter, and version Proposal actions', () => {
    const blocker = 'Host denied artifactId=artifact-private-id for characterId=character-private-id'
    const projectSnapshot = { project: v2Ready.workspace.project } as never
    document.body.innerHTML = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions}
      authoringBlocker={() => blocker}
      state={{
        ...v2Ready,
        workspace: { ...v2Ready.workspace, snapshot: projectSnapshot },
        authoring: {
          stage: 'project-refine', chapter: undefined, brief: '', input: { kind: 'structured', stage: 'project-refine', chapter: undefined, values: { kind: 'manual' } }, phase: 'editing', message: undefined,
          selectedArtifactId: undefined, selectedFinalArtifactId: undefined,
        },
      } as never}
    />)
    expect(document.body.textContent).toContain('当前还不能创建新的创作建议。请先完成上一步或稍后重试。')
    expect(document.body.textContent).not.toContain(blocker)
    for (const label of ['让 AI 起草项目设置', '将人工修改重新提交为 Proposal']) {
      expect([...document.querySelectorAll('button')].find(button => button.textContent === label)?.disabled).toBe(true)
    }

    document.body.innerHTML = renderToStaticMarkup(<NovelV2WorkbenchBody {...v2Actions}
      authoringBlocker={() => blocker}
      state={{
        ...v2Ready,
        workspace: {
          ...v2Ready.workspace,
          snapshot: {
            artifacts: [{
              artifactId: 'revision-1', chapter: 1, kind: 'revision', parentArtifactId: 'draft-1', content: '# 修订', summary: '修订稿',
              createdAt: '2026-08-21T00:01:00.000Z',
            }],
            chapterFinals: [],
          } as never,
        },
        chapters: { selected: 1, items: [{ chapter: 1, title: '退潮来信', purpose: '收到未来信', status: 'revising', plotBeats: [], keyEvents: [] }] },
        authoring: {
          stage: 'revision', chapter: 1, brief: '', input: { kind: 'prose', content: '# 手动修订' }, phase: 'editing', message: undefined,
          selectedArtifactId: 'revision-1', selectedFinalArtifactId: 'revision-1',
        },
      } as never}
    />)
    expect(document.body.textContent).toContain('当前还不能创建新的创作建议。请先完成上一步或稍后重试。')
    expect(document.body.textContent).not.toContain(blocker)
    for (const label of ['让 AI 起草第 1 章', '将手动修改重新提交为 Proposal', '让 AI 修订所选稿件', '提交定稿建议']) {
      expect([...document.querySelectorAll('button')].find(button => button.textContent === label)?.disabled).toBe(true)
    }
  })

  it('shows a known approval blocker before submission and disables the proposal action', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody
      {...editorActions}
      state={{
        ...uninitialized,
        initialization: {
          ...uninitialized.initialization,
          blocker: '当前会话已关闭原生审批，请将权限切换为“工作区写入”后再提交。',
        },
      }}
    />)

    expect(html).toContain('当前会话已关闭原生审批')
    expect(html).toMatch(/type="submit"[^>]*disabled/)
  })

  it('announces that prompt acceptance still requires native approval', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody
      {...editorActions}
      state={{
        ...uninitialized,
        initialization: { ...uninitialized.initialization, phase: 'submitted' },
      }}
    />)

    expect(html).toContain('初始化提案已发送')
    expect(html).toContain('原生审批')
    expect(html).toMatch(/type="submit"[^>]*disabled/)
  })

  it('shows exact generated identity and timestamps before enabling Session submission', () => {
    const json = JSON.stringify({
      kind: 'initialize',
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      createdAt: '2026-08-16T02:00:00.000Z',
      updatedAt: '2026-08-16T02:00:00.000Z',
      title: '潮汐来信',
    }, null, 2)
    const html = renderToStaticMarkup(<NovelWorkbenchBody
      {...editorActions}
      state={{
        ...uninitialized,
        initialization: {
          ...uninitialized.initialization,
          phase: 'preview',
          preview: { json, prompt: `proposal\n${json}` },
        },
      }}
    />)

    expect(html).toContain('即将提交的完整值')
    expect(html).toContain('123e4567-e89b-42d3-a456-426614174000')
    expect(html).toContain('2026-08-16T02:00:00.000Z')
    expect(html).toContain('提交到当前会话')
  })

  it('locks every initialization field while Session prompt admission is in flight', () => {
    document.body.innerHTML = renderToStaticMarkup(<NovelWorkbenchBody
      {...editorActions}
      state={{
        ...uninitialized,
        initialization: { ...uninitialized.initialization, phase: 'submitting' },
      }}
    />)

    const fields = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')]
    expect(fields).toHaveLength(6)
    expect(fields.every(field => field.disabled)).toBe(true)
  })

  it('keeps the initialized landing surface as a compact asset list instead of a dashboard', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={ready({ kind: 'root' })} />)

    expect(html).toContain('小说资产')
    expect(html).toContain('项目设置')
    expect(html).toContain('人物设定')
    expect(html).toContain('故事蓝图')
    expect(html).toContain('章节蓝图')
    expect(html).toContain('章节正文')
    expect(html).not.toContain('项目 ID')
    expect(html).not.toContain('123e4567-e89b-42d3-a456-426614174000')
    expect(html).not.toContain('任务看板')
    expect(html).not.toContain('SSH')
  })

  it('announces invalid chapter input and exposes focus targets for drill-in and return', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody
      {...editorActions}
      state={{
        ...ready({ kind: 'root' }),
        readFeedback: { kind: 'error', message: '章节编号必须在 1 到 20 之间。' },
      }}
    />)

    expect(html).toContain('role="alert"')
    expect(html).toContain('章节编号必须在 1 到 20 之间。')
    expect(html).toMatch(/<h3[^>]*data-ai-novel-screen-focus="true"[^>]*tabindex="-1"[^>]*>小说资产<\/h3>/)
  })

  it('renders a stale project editor with revision evidence and an explicit recovery action', () => {
    const revision = 'a'.repeat(64) as Revision
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={ready({
      kind: 'project', phase: 'stale', dirty: true, baseRevision: revision,
      latestRevision: 'b'.repeat(64) as Revision, originalText: '{}\n', summary: '调整定位',
      draft: {
        title: '本地未发送标题', language: 'zh-CN', genre: '悬疑', plannedChapters: '20',
        targetWordsPerChapter: '3000', creativeStrategy: 'consistency-first',
      },
      message: '磁盘内容已变化。当前未发送修改已保留；重新载入后才能继续提交。',
    })} />)

    expect(html).toContain('revision aaaaaaaaaaaa')
    expect(html).toContain('本地未发送标题')
    expect(html).toContain('重新载入最新版本')
    expect(html).toMatch(/class="aiNovelBackButton"[^>]*disabled/)
    expect(html).toMatch(/type="submit"[^>]*disabled/)
  })

  it('makes return navigation prominent and offers model generation inside the compact editor', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={ready({
      kind: 'project', phase: 'clean', dirty: false, baseRevision: 'a'.repeat(64) as Revision,
      originalText: '{}\n', summary: '',
      generation: { brief: '', phase: 'editing' },
      draft: {
        title: '潮汐来信', language: 'zh-CN', genre: '悬疑', plannedChapters: '20',
        targetWordsPerChapter: '3000', creativeStrategy: 'auto',
      },
    })} />)

    expect(html).toContain('aria-label="返回小说资产列表"')
    expect(html).toContain('返回小说资产')
    expect(html).toMatch(/class="aiNovelBackButton"[^>]*>.*data-icon="chevron-left"/)
    expect(html).toContain('AI 生成项目设置')
    expect(html).toContain('只会生成当前资产，并通过对话展示原生审批。')
    expect(html).toContain('对话中的单文件差异卡片')
    expect(html).toContain('“允许一次”')
    expect(html).toContain('不会再出现第二次审批')
    expect(html).toContain('aria-label="项目设置 AI 生成要求"')
    expect(html).toContain('补充要求（可选）')
    expect(html).toContain('留空时，模型会根据当前资产和项目上下文自动完善。')
    expect(html).toContain('让当前模型生成')
    expect(html).not.toMatch(/class="aiNovelPresetSecondary aiNovelGenerationButton"[^>]*disabled/)
    expect(html).not.toContain('任务看板')
  })

  it('keeps the approved generation outcome visible beside the reloaded asset fields', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={{
      ...ready({
        kind: 'project', phase: 'clean', dirty: false, baseRevision: 'b'.repeat(64) as Revision,
        originalText: '{}\n', summary: '',
        generation: {
          brief: '', phase: 'applied',
          message: '模型生成已批准并载入 revision bbbbbbbbbbbb；上方字段是磁盘中的最终内容。',
        },
        draft: {
          title: '凡尘问道', language: 'zh-CN', genre: '玄幻', plannedChapters: '8',
          targetWordsPerChapter: '2000', creativeStrategy: 'consistency-first',
        },
      }),
    }} />)

    expect(html).toContain('模型生成已批准并载入 revision bbbbbbbbbbbb')
    expect(html).toContain('上方字段是磁盘中的最终内容')
  })

  it('explains why generation is unavailable before the user clicks it', () => {
    const state = ready({
      kind: 'project', phase: 'clean', dirty: false, baseRevision: 'a'.repeat(64) as Revision,
      originalText: '{}\n', summary: '', generation: { brief: '改成玄幻题材', phase: 'editing' },
      draft: {
        title: '潮汐来信', language: 'zh-CN', genre: '悬疑', plannedChapters: '20',
        targetWordsPerChapter: '3000', creativeStrategy: 'auto',
      },
    })
    if (state.status !== 'ready') throw new Error('expected ready state')
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={{
      ...state,
      submissionBlocker: '当前会话未使用“AI 小说作家”Preset，请新建或切换到该 Preset 会话。',
    }} />)

    expect(html).toContain('当前会话未使用“AI 小说作家”Preset')
    expect(html).toMatch(/class="aiNovelPresetSecondary aiNovelGenerationButton"[^>]*disabled/)
  })

  it('keeps return, manual fields, and another generation locked during authoritative reconciliation', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={ready({
      kind: 'project', phase: 'clean', dirty: false, baseRevision: 'a'.repeat(64) as Revision,
      originalText: '{}\n', summary: '',
      generation: { brief: '玄幻题材', phase: 'reconciling' },
      draft: {
        title: '潮汐来信', language: 'zh-CN', genre: '悬疑', plannedChapters: '20',
        targetWordsPerChapter: '3000', creativeStrategy: 'auto',
      },
    })} />)

    expect(html).toMatch(/aria-label="返回小说资产列表"[^>]*disabled/)
    expect(html).toMatch(/aria-label="项目设置 AI 生成要求"[^>]*disabled/)
    expect(html).toMatch(/class="aiNovelPresetSecondary aiNovelGenerationButton"[^>]*disabled/)
  })

  it('renders character search, one selected record, and complete-asset proposal controls in one column', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={ready({
      kind: 'characters', phase: 'editing', dirty: true, baseRevision: 'a'.repeat(64) as Revision,
      originalText: '{"characters":[]}\n', summary: '', search: '林', selectedId: 'lin', visibleCharacterIds: ['lin'],
      characters: [{
        id: 'lin', name: '林澈', role: '调查者', summary: '追查旧案', goal: '找到真相',
        relationshipsText: 'zhou | 同盟 | 共同调查', notes: '',
      }, {
        id: 'zhou', name: '周遥', role: '记者', summary: '调查失踪案', goal: '公开真相',
        relationshipsText: '', notes: '',
      }],
    })} />)

    for (const text of ['搜索人物', '林澈', '人物关系', '关系人物 1', '周遥', '添加关系', '预览手动修改']) {
      expect(html).toContain(text)
    }
    expect(html).not.toContain('人物 ID')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('当前未提交表单会作为 AI 生成参考')
    expect(html).not.toMatch(/class="aiNovelPresetSecondary aiNovelGenerationButton"[^>]*disabled/)
  })

  it('renders the complete story blueprint as one labeled editor', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={ready({
      kind: 'story-blueprint', phase: 'editing', dirty: true, baseRevision: 'a'.repeat(64) as Revision,
      originalText: '{}\n', summary: '',
      draft: {
        premise: '一封迟到的信', themesText: '记忆\n责任', world: '海港城',
        mainPlot: '调查旧案', endingGoal: '公开真相',
      },
    })} />)

    for (const text of ['故事蓝图', '故事前提', '主题（每行一项）', '世界设定', '故事主线', '结局目标']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('预览手动修改')
  })

  it('renders one selected chapter blueprint without adding secondary navigation', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={ready({
      kind: 'chapter-blueprint', chapter: 2, phase: 'clean', dirty: false,
      baseRevision: 'a'.repeat(64) as Revision, originalText: '{}\n', summary: '',
      draft: {
        title: '潮汐站', purpose: '交换证据', beatsText: '抵达\n发现录音',
        characterIdsText: 'lin\nzhou', continuityNotesText: '旧案仍未公开', status: 'planned',
      },
    }, [
      { id: 'lin', name: '林澈', role: '调查者', summary: '追查旧案' },
      { id: 'zhou', name: '周遥', role: '记者', summary: '调查失踪案' },
    ])} />)

    for (const text of ['第 2 章蓝图', '章节标题', '章节目的', '情节节拍（每行一项）', '出场人物', '林澈', '周遥', '连续性备注（每行一项）', '章节状态']) {
      expect(html).toContain(text)
    }
    expect(html).not.toContain('人物 ID')
    expect(html).not.toContain('任务看板')
  })

  it('renders long Markdown in a labeled full-width draft editor with sticky actions', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={ready({
      kind: 'chapter-draft', chapter: 2, phase: 'editing', dirty: true,
      baseRevision: 'a'.repeat(64) as Revision, originalText: '# 旧稿', summary: '', text: '# 第二章\n\n潮水退去。',
    })} />)

    expect(html).toContain('第 2 章正文')
    expect(html).toContain('aria-label="章节正文 Markdown"')
    expect(html).toContain('aiNovelChapterDraftEditor')
    expect(html).toContain('aiNovelWorkbenchActions')
  })
})
