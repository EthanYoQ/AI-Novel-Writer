// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  NovelPluginCardBody,
  NovelWorkbenchBody,
} from '../src/client/workbench-view.tsx'
import type { NovelWorkbenchState } from '../src/client/workbench-store.ts'

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

describe('novel workbench presentation', () => {
  it('renders a labeled one-column initialization form and an explicit proposal action', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody
      state={{
        ...uninitialized,
        readFeedback: { kind: 'success', message: '读取完成：当前工作区尚未初始化小说项目。' },
      }}
      refresh={vi.fn()}
      selectChapter={vi.fn()}
      updateInitialization={vi.fn()}
      previewInitialization={vi.fn()}
      submitInitialization={vi.fn()}
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
      state={{
        ...uninitialized,
        initialization: {
          ...uninitialized.initialization,
          blocker: '当前会话已关闭原生审批，请将权限切换为“工作区写入”后再提交。',
        },
      }}
      refresh={vi.fn()}
      selectChapter={vi.fn()}
      updateInitialization={vi.fn()}
      previewInitialization={vi.fn()}
      submitInitialization={vi.fn()}
    />)

    expect(html).toContain('当前会话已关闭原生审批')
    expect(html).toMatch(/type="submit"[^>]*disabled/)
  })

  it('announces that prompt acceptance still requires native approval', () => {
    const html = renderToStaticMarkup(<NovelWorkbenchBody
      state={{
        ...uninitialized,
        initialization: { ...uninitialized.initialization, phase: 'submitted' },
      }}
      refresh={vi.fn()}
      selectChapter={vi.fn()}
      updateInitialization={vi.fn()}
      previewInitialization={vi.fn()}
      submitInitialization={vi.fn()}
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
      state={{
        ...uninitialized,
        initialization: {
          ...uninitialized.initialization,
          phase: 'preview',
          preview: { json, prompt: `proposal\n${json}` },
        },
      }}
      refresh={vi.fn()}
      selectChapter={vi.fn()}
      updateInitialization={vi.fn()}
      previewInitialization={vi.fn()}
      submitInitialization={vi.fn()}
    />)

    expect(html).toContain('即将提交的完整值')
    expect(html).toContain('123e4567-e89b-42d3-a456-426614174000')
    expect(html).toContain('2026-08-16T02:00:00.000Z')
    expect(html).toContain('提交到当前会话')
  })

  it('locks every initialization field while Session prompt admission is in flight', () => {
    document.body.innerHTML = renderToStaticMarkup(<NovelWorkbenchBody
      state={{
        ...uninitialized,
        initialization: { ...uninitialized.initialization, phase: 'submitting' },
      }}
      refresh={vi.fn()}
      selectChapter={vi.fn()}
      updateInitialization={vi.fn()}
      previewInitialization={vi.fn()}
      submitInitialization={vi.fn()}
    />)

    const fields = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')]
    expect(fields).toHaveLength(6)
    expect(fields.every(field => field.disabled)).toBe(true)
  })
})
