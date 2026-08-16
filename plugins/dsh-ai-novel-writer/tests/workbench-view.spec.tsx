// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  NovelPluginCardBody,
  NovelWorkbenchBody,
  type NovelWorkbenchBodyProps,
} from '../src/client/workbench-view.tsx'
import type { NovelWorkbenchState } from '../src/client/workbench-store.ts'
import type { NovelProjectId, Revision } from '../src/types.ts'

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

const editorActions: Omit<NovelWorkbenchBodyProps, 'state'> = {
  refresh: vi.fn(), selectChapter: vi.fn(), updateInitialization: vi.fn(),
  previewInitialization: vi.fn(), submitInitialization: vi.fn(), openAsset: vi.fn(),
  backToAssets: vi.fn(), updateProjectSettings: vi.fn(), updateAssetSummary: vi.fn(),
  previewAssetChange: vi.fn(), submitAssetChange: vi.fn(), discardAssetChanges: vi.fn(),
  reloadStaleAsset: vi.fn(), setCharacterSearch: vi.fn(), selectCharacter: vi.fn(),
  createCharacter: vi.fn(), updateCharacter: vi.fn(), deleteCharacter: vi.fn(),
}

function ready(screen: Extract<NovelWorkbenchState, { status: 'ready' }>['screen']): NovelWorkbenchState {
  return {
    status: 'ready', open: true, screen,
    project: {
      projectId: '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId,
      title: '潮汐来信', language: 'zh-CN', genre: '悬疑', plannedChapters: 20,
      targetWordsPerChapter: 3000, creativeStrategy: 'auto', updatedAt: '2026-08-16T00:00:00.000Z',
    },
    progress: { selectedChapter: 1, plannedChapters: 20, status: 'unplanned', draftPresent: false, draftBytes: 0 },
    characters: [{ id: 'lin', name: '林澈', role: '调查者', summary: '追查旧案' }],
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
      openWorkbench={vi.fn()}
      refresh={vi.fn()}
    />)

    for (const text of [
      'AI 小说作家', 'Host 已连接', 'Client 已挂载', 'Preset 已安装',
      'Workspace 已选择', '项目未初始化', '打开小说工作台',
    ]) expect(html).toContain(text)
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
    expect(html).not.toContain('任务看板')
    expect(html).not.toContain('SSH')
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
    expect(html).toMatch(/type="submit"[^>]*disabled/)
  })

  it('renders character search, one selected record, and complete-asset proposal controls in one column', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody {...editorActions} state={ready({
      kind: 'characters', phase: 'editing', dirty: true, baseRevision: 'a'.repeat(64) as Revision,
      originalText: '{"characters":[]}\n', summary: '', search: '林', selectedId: 'lin', visibleCharacterIds: ['lin'],
      characters: [{
        id: 'lin', name: '林澈', role: '调查者', summary: '追查旧案', goal: '找到真相',
        relationshipsText: '', notes: '',
      }],
    })} />)

    for (const text of ['搜索人物', '林澈', '人物 ID', '关系（每行：人物 ID | 类型 | 说明）', '预览修改提案']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('aria-current="true"')
  })
})
