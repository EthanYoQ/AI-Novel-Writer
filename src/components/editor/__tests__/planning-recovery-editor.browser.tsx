import { act } from 'react'
import { EditorView } from '@codemirror/view'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlueprintRecoveryDiagnostic, GenerationRecoveryContext } from '../../../shared/generation-owner-contract'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { renderPlotOutlineRange } from '../../../shared/plot-outline-contract'
import type { ProjectData } from '../../../shared/ipc-channels'
import { openPlanningRecoveryDraft, registerEditorExitSaveHandler, saveDirtyEditorChangesForExit, useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
import { globalEventBus } from '../../../shared/event-bus'
import ArchFileViewer from '../ArchFileViewer'
import ChapterCardEditor from '../ChapterCardEditor'
import WorldBuildingEditor from '../WorldBuildingEditor'
import AIOutputPanel from '../../panels/AIOutputPanel'

const session = { projectId: 'recovery-project', leaseId: 'lease-1', projectPath: 'C:\\synthetic\\planning-recovery' }
const handle = { projectId: session.projectId, epoch: 'epoch-original', rootActionId: 'root-1', runId: 'run-1' }
const project: ProjectData = {
  id: session.projectId, sessionLease: session.leaseId, name: 'Recovery', path: session.projectPath,
  novelConfig: { genre: '', subGenre: '', targetAudience: '', totalChapters: 3, wordsPerChapter: 2000,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '' },
  characterStates: '', createdAt: '', updatedAt: '',
}
const sourceExpected = { synopsis: '', premise: '原前提', charactersArch: '', worldbuilding: '', genre: '', totalChapters: 3,
  wordsPerChapter: 2000, writingLanguage: 'zh-CN' as const, plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' }
function fixture(kind: 'outline' | 'blueprint'): GenerationRecoveryContext {
  const common: GenerationRecoveryContext = {
    modelId: 'model', handle, operation: kind === 'outline' ? 'generate-plot-outline' : 'generate-directory', authorInputs: [],
    selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [], composition: null,
    lastCompositionFinishReason: 'length', attemptedPurposes: ['normal', 'compact'], draftSave: { kind: 'absent' },
    planningContinuation: { sourceHandle: handle, remainingRange: { from: 1, to: 3 }, targetUnits: 600, state: 'ready' },
  }
  if (kind === 'blueprint') return { ...common, blueprintRecovery: { sourceHandle: handle, leaseEpoch: session.leaseId,
    draft: '[{"chapterNumber":1,"title":"未完成', editRange: { from: 1, to: 3 }, writeState: 'ready', saved: null } }
  return { ...common, plotOutline: { protocol: 'chapter-outline-v3', range: { from: 1, to: 3 }, content: { maxAttemptsPerChapter: 2 },
    targetUnits: 600, cursor: { kind: 'stopped', chapterNumber: 1, reason: 'attempts-exhausted' }, sourceExpected: { ...sourceExpected },
    confirmedPrefix: '', composition: null },
  plotOutlineRecovery: { sourceHandle: handle, leaseEpoch: session.leaseId, draft: '# 情节大纲\n\n## 第1章：未完成\n', completeChapters: [], writeState: { kind: 'ready' }, saved: null } }
}
const blueprintText = JSON.stringify([{ chapterNumber: 1, title: '雨夜', role: '建置', purpose: '寻找证据', keyEvents: '找到信件',
  characters: ['沈砺'], relationships: [], suspenseHook: '信封有新线索', userGuidance: '保留作者指示', notes: '作者笔记', notesUpdatedAt: '2026-10-04T00:00:00Z' }])
let root: Root
let container: HTMLDivElement
let context: GenerationRecoveryContext
let invoke: ReturnType<typeof vi.fn>
let rejectSave: string | undefined
let pendingSave: (() => Promise<unknown>) | undefined
let savedPayload: unknown
let showCandidate: boolean
const initialEditor = useEditorStore.getState()
const initialProject = useProjectStore.getState()
const initialWorkflow = useWorkflowStore.getState()
const initialLLM = useLLMStore.getState()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  context = fixture('outline'); rejectSave = undefined; pendingSave = undefined; savedPayload = undefined; showCandidate = false
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project })
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null })
  useLLMStore.setState({ defaultModelId: 'model' })
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  setActiveProjectSessionContext(session)
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'generation:read-context') return context
    if (channel === 'db:project-core-synopsis-commit' || channel === 'db:blueprint-commit-range') {
      savedPayload = args[0]
      if (pendingSave) return pendingSave()
      return rejectSave ? { success: false, error: rejectSave } : { success: true }
    }
    if (channel === 'db:project-core-get') return { ...sourceExpected, title: 'Recovery', synopsis: '完整大纲'.repeat(30), premise: '完整故事前提'.repeat(20), worldbuilding: '世界设定'.repeat(20) }
    if (channel === 'generation:list') return showCandidate ? [{ handle, status: 'failed', artifacts: [], candidates: [] }] : []
    if (channel === 'generation:list-batches') return []
    if (channel === 'db:recovery-candidate-list') return []
    if (channel === 'skills:list-user' || channel === 'db:blueprint-get-all') return []
    if (channel === 'fs:check-exists') return false
    if (channel === 'fs:read-json') return { success: true, data: showCandidate ? { synopsis_incomplete: true, synopsis_generation_handle: handle } : {} }
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'db:character-roster-read') return { status: 'ready', renderedMarkdown: '沈砺', entries: [] }
    if (channel === 'db:character-get-all') return [{ id: 'character-1', name: '沈砺' }]
    if (channel === 'db:draft-authority-sequence') return { status: 'empty', lastChapterNumber: 0, nextChapterNumber: 1, duplicateChapterNumbers: [], authorityFingerprint: 'a'.repeat(64) }
    if (channel === 'generation:restart') throw new Error('RESTART_BOUNDARY_OBSERVED')
    throw new Error(`Unexpected IPC ${channel}`)
  })
  Object.assign(window, { aiNovelAPI: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  useEditorStore.getState().clearTabs()
  useEditorStore.setState(initialEditor); useProjectStore.setState(initialProject); useWorkflowStore.setState(initialWorkflow)
  useLLMStore.setState(initialLLM)
  setActiveProjectSessionContext(null); Reflect.deleteProperty(window, 'aiNovelAPI'); vi.restoreAllMocks()
})
async function render(kind: 'outline' | 'blueprint') {
  openPlanningRecoveryDraft(context, session.projectPath, '恢复稿')
  const tab = useEditorStore.getState().tabs[0]
  await act(async () => root.render(kind === 'outline'
    ? <ArchFileViewer tabId={tab.id} filePath="ai-novel://core/synopsis" projectKey={session.projectPath} content={tab.content ?? ''} savedContent={tab.savedContent ?? ''} />
    : <ChapterCardEditor tabId={tab.id} projectKey={session.projectPath} />))
  await vi.waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull())
}
function editor(): EditorView {
  const element = container.querySelector<HTMLElement>('.cm-editor')
  const view = element && EditorView.findFromDOM(element)
  if (!view) throw new Error('Missing editor')
  return view
}
async function edit(value: string) { await act(async () => { const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }) }) }
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
function noModel() { expect(invoke.mock.calls.some(([channel]) => channel === 'generation:execute' || channel === 'generation:begin' || channel === 'generation:restart')).toBe(false) }

describe('planning recovery editors', () => {
  it.each(['button', 'workflow'] as const)('reports a rejected recovery refresh from %s', async source => {
    await render('outline')
    invoke.mockRejectedValueOnce(new Error('Recovery context reload failed'))
    await act(async () => {
      if (source === 'button') {
        container.querySelector<HTMLButtonElement>('button[title="从磁盘重新加载（AI 生成完成后可点击刷新）"]')!.click()
      } else {
        globalEventBus.emit('WORKFLOW_COMPLETE', { type: 'architecture_generation', projectPath: session.projectPath, projectSession: session, runId: 'completed-recovery' })
      }
    })
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('Recovery context reload failed'))
    noModel()
  })

  it('reports a blueprint resource conflict without adding a failed continuation', async () => {
    context = fixture('blueprint')
    await render('blueprint')
    await act(async () => useWorkflowStore.setState({ activeRuns: [{
      id: 'running-blueprint', type: 'directory', title: '正在生成蓝图', status: 'running',
      projectPath: session.projectPath, projectSession: session, resourceKeys: ['blueprints'],
      writingLanguage: 'zh-CN', uiLocale: 'zh-CN', currentStepIndex: 0, steps: [], createdAt: '',
    }] }))
    await act(async () => button('继续生成缺少的章节').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('正在生成蓝图')
    expect(useWorkflowStore.getState().history).toHaveLength(0)
    noModel()
  })

  for (const language of ['zh-CN', 'en-US'] as const) {
    for (const keepTail of [true, false]) {
      it(`outline author tail ${language} saves a completed prefix with ${keepTail ? 'old' : 'deleted'} machine progress`, async () => {
        const english = language === 'en-US'
        const title = english ? '# Plot Outline' : '# 情节大纲'
        const body = english ? '## Chapter 1: Rain\nThe author keeps every clue.\n\n> Author note: preserve this quotation.' : '## 第1章：雨夜\n作者保留每一条线索。\n\n> 作者笔记：保留这段引文。'
        const oldTail = english ? '> This outline covers chapters 1-2 of 3; the remaining chapters will be generated in later batches.' : '> 本大纲已覆盖至第 2 章（全书 3 章），其余章节将在后续批次继续生成。'
        const newTail = english ? '> This outline covers chapters 1-1 of 3; the remaining chapters will be generated in later batches.' : '> 本大纲已覆盖至第 1 章（全书 3 章），其余章节将在后续批次继续生成。'
        context = fixture('outline')
        if (!context.plotOutline || !context.plotOutlineRecovery) throw new Error('Missing outline fixture')
        context.plotOutline.sourceExpected.writingLanguage = language
        context.plotOutline.composition = { algorithm: 'chapter-outline-v3', text: body, textHash: 'a'.repeat(64), artifactIds: ['chapter-1'], sources: [], chapters: [{ chapterNumber: 1, artifactIds: ['chapter-1'], textHash: 'a'.repeat(64) }] }
        context.plotOutline.cursor = { kind: 'stopped', chapterNumber: 2, reason: 'attempts-exhausted' }
        context.plotOutlineRecovery.completeChapters = [1]
        const prefix = `${title}\n\n${body}`
        const original = `${prefix}\n\n${english ? '## Chapter 2: Unfinished' : '## 第2章：未完成'}\n截断\n\n${oldTail}`
        context.plotOutlineRecovery.draft = original
        await render('outline')
        await edit(prefix + (keepTail ? `\n\n${oldTail}` : ''))
        await act(async () => button('保存').click())
        const expected = `${prefix}\n\n${newTail}`
        expect(savedPayload).toMatchObject({ synopsis: expected, expected: context.plotOutline.sourceExpected, authorRecovery: { committedRange: { from: 1, to: 1 } } })
        expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: expected, savedContent: expected, originalContent: original, dirty: false })
        expect(editor().state.doc.toString()).toBe(expected)
        await act(async () => editor().contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })))
        expect(invoke.mock.calls.filter(([name]) => name === 'db:project-core-synopsis-commit')).toHaveLength(1)
        noModel()
      })
    }
  }
  it('outline author tail preserves an edited quotation instead of treating it as machine progress', async () => {
    context = fixture('outline')
    const authored = '# 情节大纲\n\n## 第1章：雨夜\n作者正文。\n\n> 本大纲已覆盖至第 2 章（全书 3 章），其余章节将在后续批次继续生成。作者要求保留。'
    await render('outline'); await edit(authored)
    await act(async () => button('保存').click())
    const expected = authored + '\n\n> 本大纲已覆盖至第 1 章（全书 3 章），其余章节将在后续批次继续生成。'
    expect(savedPayload).toMatchObject({ synopsis: expected })
    expect(editor().state.doc.toString()).toBe(expected)
    noModel()
  })
  it.each([false, true])('outline author tail retains the existing outside prefix and rejects changes=%s', async changed => {
    context = fixture('outline')
    if (!context.plotOutline || !context.plotOutlineRecovery) throw new Error('Missing outline fixture')
    const existing = '# 情节大纲\n\n## 第1章：原章\n不可改写的原文。\n\n> 本大纲已覆盖至第 1 章（全书 3 章），其余章节将在后续批次继续生成。'
    context.plotOutline.sourceExpected.synopsis = existing
    context.plotOutline.range = { from: 2, to: 3 }
    context.plotOutline.confirmedPrefix = '## 第1章：原章\n不可改写的原文。'
    context.plotOutlineRecovery.draft = '# 情节大纲\n\n## 第1章：原章\n不可改写的原文。\n\n## 第2章：恢复\n截断\n\n> 本大纲已覆盖至第 2 章（全书 3 章），其余章节将在后续批次继续生成。'
    await render('outline')
    const authored = '# 情节大纲\n\n## 第1章：原章\n' + (changed ? '被篡改的原文。' : '不可改写的原文。') + '\n\n## 第2章：恢复\n作者补齐的正文。'
    await edit(authored)
    await act(async () => button('保存').click())
    if (changed) {
      expect(savedPayload).toBeUndefined()
      expect(editor().state.doc.toString()).toBe(authored)
      expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
    } else {
      expect(savedPayload).toMatchObject({ synopsis: authored + '\n\n> 本大纲已覆盖至第 2 章（全书 3 章），其余章节将在后续批次继续生成。' })
      expect(useEditorStore.getState().tabs[0].dirty).toBe(false)
    }
    noModel()
  })
  it.each([false, true])('outline author tail freezes canonical payload across lost ACK and later edits=%s', async laterEdit => {
    context = fixture('outline')
    await render('outline')
    const authored = '# 情节大纲\n\n## 第1章：雨夜\n作者补齐的正文。'
    const canonical = authored + '\n\n> 本大纲已覆盖至第 1 章（全书 3 章），其余章节将在后续批次继续生成。'
    await edit(authored)
    pendingSave = async () => { throw new Error('IPC_ACK_LOST_AFTER_COMMIT') }
    await act(async () => button('保存').click())
    expect(savedPayload).toMatchObject({ synopsis: canonical })
    const first = structuredClone(savedPayload)
    const later = authored + '\n作者在回包丢失后继续输入。'
    if (laterEdit) await edit(later)
    await act(async () => root.render(null))
    await render('outline')
    pendingSave = async () => ({ success: true })
    await act(async () => button('保存').click())
    expect(savedPayload).toEqual(first)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: laterEdit ? later : canonical, savedContent: canonical, dirty: laterEdit })
    expect(editor().state.doc.toString()).toBe(laterEdit ? later : canonical)
    noModel()
  })
  it.each([
    { kind: 'retired', code: 'GENERATION_BLUEPRINTS_CLEARED', reason: '蓝图已清空，旧恢复稿不能保存或续接' },
    { kind: 'invalid', code: 'GENERATION_DIRECTORY_PROGRESS_INVALID', reason: '蓝图生成进度校验失败，旧恢复稿不能保存或续接' },
    { kind: 'invalid', code: 'GENERATION_BLUEPRINT_AUTHOR_RECEIPT_INVALID', reason: '蓝图作者保存记录校验失败，旧恢复稿不能保存或续接' },
  ] satisfies (Omit<BlueprintRecoveryDiagnostic, 'runId'> & { reason: string })[])('unavailable blueprint $code keeps editable text without replaying a pending save', async diagnostic => {
    context = fixture('blueprint')
    await render('blueprint')
    const original = useEditorStore.getState().tabs[0].originalContent
    await edit(blueprintText)
    pendingSave = async () => { throw new Error('IPC_ACK_LOST_AFTER_COMMIT') }
    await act(async () => button('保存恢复蓝图').click())
    expect(useEditorStore.getState().tabs[0].planningSaveSnapshot?.status).toBe('pending')
    expect(invoke.mock.calls.filter(([name]) => name === 'db:blueprint-commit-range')).toHaveLength(1)
    if (!context.blueprintRecovery) throw new Error('Missing blueprint recovery')
    context = { ...context, planningContinuation: undefined, blueprintRecovery: {
      ...context.blueprintRecovery, writeState: 'unavailable', editRange: null, saved: null,
      diagnostic: { runId: handle.runId, kind: diagnostic.kind, code: diagnostic.code },
    } }
    await act(async () => root.render(null))
    await render('blueprint')
    expect(container.textContent).toContain(diagnostic.reason)
    expect(container.querySelector('details pre')?.textContent).toBe(original)
    expect(editor().state.doc.toString()).toBe(blueprintText)
    expect(button('保存恢复蓝图').disabled).toBe(true)
    expect(button('继续生成缺少的章节').disabled).toBe(true)
    const later = blueprintText + '\n作者保留的修改'
    await edit(later)
    const data = new DataTransfer()
    await act(async () => {
      const view = editor(); view.focus(); view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
      view.contentDOM.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    expect(data.getData('text/plain')).toBe(later)
    await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow() })
    expect(invoke.mock.calls.filter(([name]) => name === 'db:blueprint-commit-range')).toHaveLength(1)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: later, originalContent: original, dirty: true })
    noModel()
  })
  for (const kind of ['outline', 'blueprint'] as const) {
    const channel = kind === 'outline' ? 'db:project-core-synopsis-commit' : 'db:blueprint-commit-range'
    const validText = () => kind === 'outline' ? renderPlotOutlineRange('## 第1章：雨夜\n找到信件。', { from: 1, to: 1 }, sourceExpected) : blueprintText
    const recordAuthorReceipt = () => {
      context = structuredClone(context)
      const operationId = useEditorStore.getState().tabs[0].planningSaveOperationId
      if (!operationId) throw new Error('Missing operation ID')
      const receipt = { operationId, sourceHandle: handle, requestedRange: { from: 1, to: 3 }, committedRange: { from: 1, to: 1 }, remainingRange: { from: 2, to: 3 } }
      if (context.plotOutlineRecovery) {
        context.plotOutlineRecovery.saved = { ...receipt, kind: 'author-edit', synopsisHash: 'a'.repeat(64), payloadHash: 'b'.repeat(64), idempotent: false }
        context.plotOutlineRecovery.writeState = { kind: 'blocked', reason: 'author-saved' }
      }
      if (context.blueprintRecovery) {
        context.blueprintRecovery.saved = { ...receipt, kind: 'blueprint-author-edit', payloadHash: 'a'.repeat(64) }
        context.blueprintRecovery.writeState = 'author-saved'
        context.blueprintRecovery.editRange = { from: 2, to: 3 }
      }
      context.planningContinuation = { sourceHandle: handle, remainingRange: { from: 2, to: 3 }, targetUnits: 600, state: 'ready' }
    }
    const shortcutSave = async () => {
      await act(async () => editor().contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })))
    }
    for (const retry of ['button', 'shortcut', 'exit', 'new-lease'] as const) {
      it(`${kind} lost save ACK retries frozen content after remount via ${retry}`, async () => {
        context = fixture(kind); await render(kind); await edit(validText())
        const original = useEditorStore.getState().tabs[0].originalContent
        let first: unknown
        pendingSave = async () => {
          first = structuredClone(savedPayload)
          recordAuthorReceipt()
          throw new Error('IPC_ACK_LOST_AFTER_COMMIT')
        }
        await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
        const later = validText().replace('找到信件', '找到新的信件')
        await edit(later)
        await act(async () => {
          const input = container.querySelector('input[type="number"]')
          if (!(input instanceof HTMLInputElement)) throw new Error('Missing range input')
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '2')
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => root.render(null))
        if (retry === 'new-lease') {
          setActiveProjectSessionContext({ ...session, leaseId: 'lease-2' })
          useProjectStore.setState({ currentProject: { ...project, sessionLease: 'lease-2' } })
          if (context.plotOutlineRecovery) context.plotOutlineRecovery.leaseEpoch = 'lease-2'
          if (context.blueprintRecovery) context.blueprintRecovery.leaseEpoch = 'lease-2'
        }
        await render(kind)
        pendingSave = async () => ({ success: true })
        if (retry === 'exit') {
          await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow('保存期间仍有未保存修改') })
        } else if (retry === 'shortcut') await shortcutSave()
        else await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
        await vi.waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(2))
        const expected = structuredClone(first)
        if (retry === 'new-lease') {
          if (!expected || typeof expected !== 'object' || !('authorRecovery' in expected)
            || !expected.authorRecovery || typeof expected.authorRecovery !== 'object') throw new Error('Missing author recovery request')
          Object.assign(expected.authorRecovery, { leaseEpoch: 'lease-2' })
        }
        expect(savedPayload, JSON.stringify({ first, second: savedPayload })).toEqual(expected)
        expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: later, savedContent: validText(), originalContent: original, dirty: true })
        await shortcutSave()
        expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(2)
        expect(useEditorStore.getState().tabs[0]).toMatchObject({ savedContent: validText(), dirty: true })
        const data = new DataTransfer()
        await act(async () => {
          const view = editor(); view.focus(); view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
          view.contentDOM.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
        })
        expect(data.getData('text/plain')).toBe(later)
        expect(button(kind === 'outline' ? '保存' : '保存恢复蓝图').disabled).toBe(true)
        noModel()
      })
    }
    it(`${kind} invalid first text can be corrected before any submission freezes`, async () => {
      context = fixture(kind); await render(kind); await edit('未完成内容')
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(0)
      await edit(validText())
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(1)
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ savedContent: validText(), dirty: false }); noModel()
    })
    it(`${kind} a late ACK from an old lease leaves its snapshot retryable`, async () => {
      context = fixture(kind); await render(kind); await edit(validText())
      let finish: ((value: unknown) => void) | undefined
      pendingSave = () => new Promise(resolve => { finish = resolve })
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      await vi.waitFor(() => expect(finish).toBeDefined())
      const first = structuredClone(savedPayload)
      const later = validText().replace('找到信件', '找到新的信件')
      await edit(later)
      recordAuthorReceipt()
      setActiveProjectSessionContext({ ...session, leaseId: 'lease-2' })
      if (context.plotOutlineRecovery) context.plotOutlineRecovery.leaseEpoch = 'lease-2'
      if (context.blueprintRecovery) context.blueprintRecovery.leaseEpoch = 'lease-2'
      await act(async () => {
        useProjectStore.setState({ currentProject: { ...project, sessionLease: 'lease-2' } })
        finish?.({ success: true })
      })
      await act(async () => root.render(null))
      await render(kind)
      pendingSave = async () => ({ success: true })
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(2)
      expect(savedPayload).toMatchObject({ authorRecovery: { leaseEpoch: 'lease-2' } })
      if (!first || typeof first !== 'object' || !('authorRecovery' in first)
        || !first.authorRecovery || typeof first.authorRecovery !== 'object') throw new Error('Missing author recovery request')
      Object.assign(first.authorRecovery, { leaseEpoch: 'lease-2' })
      expect(savedPayload).toEqual(first)
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ savedContent: validText(), content: later, dirty: true }); noModel()
    })
    it(`${kind} explicit uncommitted rejection permits corrected text on retry`, async () => {
      context = fixture(kind); rejectSave = '作者内容未通过检查'; await render(kind); await edit(validText())
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
      const later = validText().replace('找到信件', '找到新的信件')
      await edit(later); rejectSave = undefined
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(2)
      expect(savedPayload).toMatchObject(kind === 'outline' ? { synopsis: later } : { blueprints: [{ keyEvents: '找到新的信件' }] })
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ savedContent: later, dirty: false }); noModel()
    })
    it(`${kind} a rejected replay cannot release an earlier unknown submission`, async () => {
      context = fixture(kind); await render(kind); await edit(validText())
      pendingSave = async () => { throw new Error('IPC_ACK_UNKNOWN') }
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      const first = structuredClone(savedPayload)
      await edit(validText().replace('找到信件', '找到新的信件'))
      pendingSave = async () => ({ success: false, error: 'AUTHOR_RECEIPT_CONFLICT' })
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      expect(savedPayload).toEqual(first)
      expect(useEditorStore.getState().tabs[0].savedContent).toBe('')
      pendingSave = async () => ({ success: true })
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(3)
      expect(savedPayload).toEqual(first)
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ savedContent: validText(), dirty: true }); noModel()
    })
    it(`${kind} edits double-length candidate and saves only through author recovery`, async () => {
      context = fixture(kind); await render(kind); await edit(validText())
      const operationId = useEditorStore.getState().tabs[0].planningSaveOperationId
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(1)
      expect(savedPayload).toMatchObject({ authorRecovery: { sourceHandle: handle, leaseEpoch: session.leaseId } })
      expect(savedPayload).toMatchObject(kind === 'outline' ? { expected: sourceExpected, synopsis: validText(), authorRecovery: { operationId, committedRange: { from: 1, to: 1 } } }
        : { operationId, mode: 'replace-range', startChapter: 1, endChapter: 1, blueprints: [{ chapterNumber: 1, keyEvents: '找到信件', userGuidance: '保留作者指示', notes: '作者笔记', notesUpdatedAt: '2026-10-04T00:00:00Z' }] })
      expect(useEditorStore.getState().tabs[0].dirty).toBe(false)
      expect(invoke.mock.calls.some(([name]) => /upsert|project-core-update/.test(name))).toBe(false); noModel()
    })
    it(`${kind} preserves dirty and operation identity after conflict and retry`, async () => {
      context = fixture(kind); rejectSave = '来源已变化'; await render(kind); await edit(validText())
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
      const first = savedPayload
      await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow('来源已变化') })
      expect(savedPayload).toEqual(first); expect(container.textContent).toContain('来源已变化'); noModel()
    })
    it(`${kind} exit-save keeps later input dirty while the snapshot saves`, async () => {
      context = fixture(kind); await render(kind); await edit(validText())
      let finish: ((value: unknown) => void) | undefined
      pendingSave = () => new Promise(resolve => { finish = resolve })
      let saving: Promise<void> = Promise.resolve()
      await act(async () => { saving = saveDirtyEditorChangesForExit(session.projectPath); void saving.catch(() => {}) })
      await vi.waitFor(() => expect(finish).toBeDefined())
      await edit(validText() + '\n作者继续输入')
      await act(async () => { finish?.({ success: true }); await expect(saving).rejects.toThrow('保存期间仍有未保存修改') })
      expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
      expect(useEditorStore.getState().tabs[0].savedContent).toBe(validText())
      expect(editor().state.doc.toString()).toContain('作者继续输入'); noModel()
    })
    it(`${kind} in-flight and completion unknown do not send automatic requests`, async () => {
      context = fixture(kind); context.lastCompositionFinishReason = null
      if (context.plotOutlineRecovery) context.plotOutlineRecovery.writeState = { kind: 'blocked', reason: 'in-flight' }
      if (context.blueprintRecovery) context.blueprintRecovery.writeState = 'in-flight'
      context.planningContinuation!.state = 'in-flight'
      await render(kind)
      expect(button('继续生成缺少的章节').disabled).toBe(true)
      await edit(validText())
      await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow() })
      expect(invoke.mock.calls.some(([name]) => name === channel)).toBe(false); noModel()
    })
    it(`${kind} reopening preserves author text and normal ledger settlement cannot clear it`, async () => {
      context = fixture(kind); await render(kind); await edit('作者尚未保存的修改')
      await act(async () => {
        openPlanningRecoveryDraft(context, session.projectPath, '恢复稿')
        useEditorStore.getState().setProjectEditorDirty('chapter-card', session.projectPath, false)
      })
      expect(useEditorStore.getState().tabs).toHaveLength(1)
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '作者尚未保存的修改', dirty: true })
      expect(useEditorStore.getState().tabs[0].originalContent).toBe(kind === 'outline' ? context.plotOutlineRecovery?.draft : context.blueprintRecovery?.draft); noModel()
    })
    it(`${kind} rejects a save from an old project lease`, async () => {
      context = fixture(kind); await render(kind); await edit(validText())
      setActiveProjectSessionContext({ ...session, leaseId: 'new-lease' })
      await act(async () => useProjectStore.setState({ currentProject: { ...project, sessionLease: 'new-lease' } }))
      await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow() })
      expect(invoke.mock.calls.some(([name]) => name === channel)).toBe(false); noModel()
    })
    it(`${kind} explicitly continues zero-prefix with frozen target and original source`, async () => {
      context = fixture(kind); await render(kind); noModel()
      await act(async () => button('继续生成缺少的章节').click())
      await vi.waitFor(() => expect(invoke.mock.calls.some(([name]) => name === 'generation:restart'), JSON.stringify({ channels: invoke.mock.calls.map(([name]) => name), history: useWorkflowStore.getState().history.map(run => run.error), visible: container.textContent })).toBe(true))
      const restart = invoke.mock.calls.find(([name]) => name === 'generation:restart')
      expect(restart?.[1]).toEqual(handle)
      expect(restart?.[2]).toMatchObject({ authorInputs: expect.arrayContaining([{ id: 'planning:target-units', text: '600' }]) })
      expect(invoke.mock.calls.some(([name]) => name === channel || name === 'generation:begin' || name === 'generation:execute')).toBe(false)
    })
    it(`${kind} shortcut save follows author recovery and keeps other project drafts`, async () => {
      context = fixture(kind); await render(kind); await edit(validText())
      await act(async () => useEditorStore.getState().openFile({ id: 'other', name: 'other', type: 'arch-file', projectKey: 'C:\\other', content: '别的项目草稿', savedContent: '', dirty: true }))
      await act(async () => editor().contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })))
      await vi.waitFor(() => expect(invoke.mock.calls.some(([name]) => name === channel)).toBe(true))
      expect(useEditorStore.getState().tabs.find(tab => tab.projectKey === 'C:\\other')).toMatchObject({ content: '别的项目草稿', dirty: true }); noModel()
    })
    it(`${kind} no remaining range cannot start an empty action`, async () => {
      context = fixture(kind)
      context.planningContinuation = { sourceHandle: handle, remainingRange: null, targetUnits: 600, state: 'complete' }
      await render(kind)
      expect(button('继续生成缺少的章节').disabled).toBe(true); noModel()
    })
    it(`${kind} source-changed editor preserves raw text and blocks local save`, async () => {
      context = fixture(kind)
      if (context.plotOutlineRecovery) context.plotOutlineRecovery.writeState = { kind: 'blocked', reason: 'source-changed' }
      if (context.blueprintRecovery) context.blueprintRecovery.writeState = 'source-changed'
      context.planningContinuation!.state = 'source-changed'
      await render(kind); await edit(validText())
      await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow() })
      expect(editor().state.doc.toString()).toBe(validText())
      expect(invoke.mock.calls.some(([name]) => name === channel)).toBe(false); noModel()
    })
    it(`${kind} missing reply retry uses the same source and frozen input`, async () => {
      context = fixture(kind); await render(kind)
      await act(async () => button('继续生成缺少的章节').click())
      await vi.waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === 'generation:restart')).toHaveLength(1))
      await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns).toHaveLength(0))
      await expect.element(button('继续生成缺少的章节')).toBeEnabled()
      await act(async () => button('继续生成缺少的章节').click())
      await vi.waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === 'generation:restart')).toHaveLength(2))
      const calls = invoke.mock.calls.filter(([name]) => name === 'generation:restart')
      expect(calls[0][1]).toEqual(calls[1][1])
      expect(calls[0][2].authorInputs).toEqual(calls[1][2].authorInputs)
      expect(invoke.mock.calls.some(([name]) => name === 'generation:begin' || name === 'generation:execute')).toBe(false)
    })
    it(`${kind} saves the complete prefix before continuing only the authoritative remainder`, async () => {
      context = fixture(kind)
      context.planningContinuation!.state = 'save-prefix'
      if (context.plotOutlineRecovery) {
        context.plotOutlineRecovery.completeChapters = [1]
        context.plotOutlineRecovery.draft = validText() + '\n\n## 第2章：未完成\n'
      }
      await render(kind); await edit(validText())
      expect(button('继续生成缺少的章节').disabled).toBe(true)
      pendingSave = async () => {
        context = { ...context, planningContinuation: { sourceHandle: handle, remainingRange: { from: 2, to: 3 }, targetUnits: 600, state: 'ready' } }
        return { success: true }
      }
      await act(async () => button(kind === 'outline' ? '保存' : '保存恢复蓝图').click())
      noModel()
      expect(container.textContent).toContain('待完成第 2 至 3 章')
      await act(async () => button('继续生成缺少的章节').click())
      await vi.waitFor(() => expect(invoke.mock.calls.some(([name]) => name === 'generation:restart')).toBe(true))
      const restart = invoke.mock.calls.find(([name]) => name === 'generation:restart')
      const inputs = JSON.stringify(restart?.[2].authorInputs)
      expect(inputs).toContain(kind === 'outline' ? '\\"synopsisRange\\":{\\"from\\":2,\\"to\\":3}' : '\\"startChapter\\":2')
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(1)
    })
    it(`${kind} displays the writing-language target unit independently of interface language`, async () => {
      context = fixture(kind)
      if (context.plotOutline) context.plotOutline.sourceExpected.writingLanguage = 'en-US'
      useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, writingLanguage: 'en-US' } } })
      await render(kind)
      expect(container.textContent).toContain('每章目标 600 词')
      noModel()
    })
  }
  it.each(['architecture', 'blueprint', 'failure-panel'] as const)('%s opens the same editable recovery draft twice without replacing dirty text', async entry => {
    showCandidate = true
    context = fixture(entry === 'blueprint' ? 'blueprint' : 'outline')
    await act(async () => root.render(entry === 'architecture' ? <WorldBuildingEditor projectKey={session.projectPath} />
      : entry === 'blueprint' ? <ChapterCardEditor projectKey={session.projectPath} /> : <AIOutputPanel />))
    await vi.waitFor(() => expect(button('编辑恢复稿')).toBeDefined())
    await act(async () => button('编辑恢复稿').click())
    const tab = useEditorStore.getState().tabs[0]
    expect(tab.planningRecovery?.handle).toEqual(handle)
    await act(async () => useEditorStore.getState().updateTabContent(tab.id, '我已修正的候选'))
    await act(async () => button('编辑恢复稿').click())
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '我已修正的候选', dirty: true })
    noModel()
  })
  it('closing a recovery tab preserves the ordinary blueprint exit-save handler', async () => {
    context = fixture('blueprint'); await render('blueprint')
    const recoveryId = useEditorStore.getState().tabs[0].id
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => useEditorStore.getState().openFile({ id: 'ordinary', name: '蓝图', type: 'chapter-card', projectKey: session.projectPath, dirty: true }))
    const ordinary = useEditorStore.getState().tabs.find(tab => !tab.planningRecovery)
    if (!ordinary) throw new Error('Missing ordinary blueprint tab')
    const save = vi.fn(async () => useEditorStore.getState().markTabSaved(ordinary.id))
    const dispose = registerEditorExitSaveHandler({ type: 'chapter-card', projectKey: session.projectPath, save })
    await act(async () => useEditorStore.getState().closeTab(recoveryId))
    await act(async () => saveDirtyEditorChangesForExit(session.projectPath))
    expect(save).toHaveBeenCalledOnce()
    dispose(); noModel()
  })
})
