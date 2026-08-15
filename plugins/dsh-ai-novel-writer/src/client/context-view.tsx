/** React surfaces for the read-only novel context drawer. */

import { useEffect, useRef, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import { IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { NovelContextController, NovelContextState } from './context-store.ts'
import type { PresetSetupController } from './setup-store.ts'
import { PresetSetupBody } from './setup-view.tsx'

const drawerReturnTargets = new WeakMap<NovelContextController, HTMLElement>()

/**
 * Focus a non-modal drawer, close it with Escape, and restore its invoking control.
 *
 * @param drawer Drawer element receiving fallback focus.
 * @param initialFocus Preferred element focused after open.
 * @param returnFocus Invoking control restored after close.
 * @param close Close action used by the Escape key.
 * @returns A disposer that removes the key listener and restores focus.
 */
export function installDrawerKeyboardScope(
  drawer: HTMLElement,
  initialFocus: HTMLElement,
  returnFocus: HTMLElement | undefined,
  close: () => void,
): () => void {
  initialFocus.focus()
  const target = drawer.ownerDocument
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }
  target.addEventListener('keydown', onKeyDown)
  return () => {
    target.removeEventListener('keydown', onKeyDown)
    if (returnFocus?.isConnected) returnFocus.focus()
  }
}

/** Props for the pure read-only context body. */
export interface NovelContextBodyProps {
  readonly state: NovelContextState
  readonly refresh: () => void
  readonly selectChapter: (chapter: number) => void
}

function TextList({ items, empty }: { readonly items: readonly string[]; readonly empty: string }) {
  if (items.length === 0) return <p className="aiNovelContextMuted">{empty}</p>
  return <ul>{items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
}

/**
 * Render project context without initialization, editing, approval, or filesystem controls.
 *
 * @param props Current context state and read-only navigation actions.
 * @returns Accessible context content for the side drawer.
 */
export function NovelContextBody({ state, refresh, selectChapter }: NovelContextBodyProps) {
  switch (state.status) {
    case 'idle':
    case 'loading': return <p role="status">正在读取小说上下文…</p>
    case 'empty': return <p role="status">当前会话不属于已注册工作区。</p>
    case 'not-initialized':
      return (
        <div role="status">
          <p>当前工作区尚未初始化 Harness 小说项目。</p>
          <p>请回到对话，让 AI 小说作家提出初始化修改并通过 Harness 审批。</p>
          <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重新读取</button>
        </div>
      )
    case 'disconnected':
      return (
        <div role="alert">
          <p>Harness 连接已断开。</p>
          <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重新连接后读取</button>
        </div>
      )
    case 'error':
      return (
        <div role="alert">
          <p>小说上下文读取失败：{state.message}</p>
          <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重试</button>
        </div>
      )
    case 'ready': {
      const blueprint = state.chapterBlueprint
      return (
        <div className="aiNovelContextSections">
          <section aria-labelledby="ai-novel-project-summary">
            <div className="aiNovelContextSectionHeader">
              <h3 id="ai-novel-project-summary">{state.project.title}</h3>
              <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>刷新</button>
            </div>
            <dl className="aiNovelContextFacts">
              <div><dt>项目 ID</dt><dd>{state.project.projectId}</dd></div>
              <div><dt>类型</dt><dd>{state.project.genre}</dd></div>
              <div><dt>语言</dt><dd>{state.project.language}</dd></div>
              <div><dt>创作策略</dt><dd>{state.project.creativeStrategy}</dd></div>
              <div><dt>目标字数</dt><dd>{state.project.targetWordsPerChapter}</dd></div>
            </dl>
          </section>
          <section aria-labelledby="ai-novel-chapter-progress">
            <div className="aiNovelContextSectionHeader">
              <h3 id="ai-novel-chapter-progress">章节进度</h3>
              <label>
                <span className="aiNovelContextSrOnly">选择章节</span>
                <input
                  type="number"
                  min={1}
                  max={state.progress.plannedChapters}
                  value={state.progress.selectedChapter}
                  aria-label="选择小说章节"
                  onChange={event => {
                    const chapter = Number(event.currentTarget.value)
                    if (Number.isSafeInteger(chapter)
                      && chapter >= 1
                      && chapter <= state.progress.plannedChapters) selectChapter(chapter)
                  }}
                />
              </label>
            </div>
            <p>第 {state.progress.selectedChapter} / {state.progress.plannedChapters} 章 · {state.progress.status}</p>
            <p className="aiNovelContextMuted">正文 {state.progress.draftPresent ? `${state.progress.draftBytes} 字节` : '尚未创建'}</p>
          </section>
          <section aria-labelledby="ai-novel-characters">
            <h3 id="ai-novel-characters">人物摘要</h3>
            {state.characters.length === 0
              ? <p className="aiNovelContextMuted">尚未建立人物表。</p>
              : <ul className="aiNovelContextCharacters">{state.characters.map(character => (
                  <li key={character.id}><strong>{character.name}</strong><span>{character.role}</span><p>{character.summary}</p></li>
                ))}</ul>}
          </section>
          <section aria-labelledby="ai-novel-story-blueprint">
            <h3 id="ai-novel-story-blueprint">故事蓝图</h3>
            {state.storyBlueprint === null
              ? <p className="aiNovelContextMuted">尚未建立故事蓝图。</p>
              : <>
                  <p>{state.storyBlueprint.premise}</p>
                  <TextList items={state.storyBlueprint.themes} empty="暂无主题" />
                  <p>{state.storyBlueprint.world}</p>
                  <p>{state.storyBlueprint.mainPlot}</p>
                  <p>{state.storyBlueprint.endingGoal}</p>
                </>}
          </section>
          <section aria-labelledby="ai-novel-chapter-blueprint">
            <h3 id="ai-novel-chapter-blueprint">章节蓝图</h3>
            {blueprint === null
              ? <p className="aiNovelContextMuted">本章尚未建立蓝图。</p>
              : <>
                  <h4>{blueprint.title}</h4>
                  <p>{blueprint.purpose}</p>
                  <TextList items={blueprint.beats} empty="暂无情节节拍" />
                  <TextList items={blueprint.continuityNotes} empty="暂无连续性备注" />
                </>}
          </section>
          <section aria-labelledby="ai-novel-draft-preview">
            <h3 id="ai-novel-draft-preview">正文预览</h3>
            {state.draft === null
              ? <p className="aiNovelContextMuted">本章尚未创建正文。</p>
              : <>
                  <pre className="aiNovelContextPreview">{state.draft.preview}</pre>
                  {state.draft.truncated ? <p role="status">预览已截断；完整正文仍保留在项目中。</p> : undefined}
                </>}
          </section>
          {state.omittedSources.length > 0
            ? <p role="status">读取预算已省略：{state.omittedSources.join('、')}</p>
            : undefined}
        </div>
      )
    }
  }
}

interface ContextInjected {
  readonly contextController: NovelContextController
  readonly setupController: PresetSetupController
}

type NovelContextTriggerProps = PropsRuntime<'sidebar.footer.action'> & ContextInjected
type NovelContextOverlayProps = PropsRuntime<'shell.overlay'> & ContextInjected

/**
 * Render the sidebar action and synchronize its controller with shell selection and session activity.
 *
 * @param props Global shell selectors, sidebar width state, and shared controllers.
 * @returns A keyboard-operable native button.
 */
export function NovelContextTrigger({
  wide, contextController, setupController,
}: NovelContextTriggerProps) {
  const contextState = useSyncExternalStore(
    listener => contextController.subscribe(listener),
    () => contextController.getSnapshot(),
  )
  const open = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    drawerReturnTargets.set(contextController, event.currentTarget)
    setupController.open()
    void Promise.all([contextController.open(), setupController.load()])
  }
  return (
    <button
      type="button"
      className="aiNovelContextTrigger"
      aria-label="打开小说上下文"
      aria-haspopup="dialog"
      aria-expanded={contextState.open}
      onClick={open}
    >
      <IconListPenOutline16 />
      {wide ? <span>小说上下文</span> : undefined}
    </button>
  )
}

/**
 * Render the non-modal context drawer in the root shell overlay slot.
 *
 * @param props Shared read and setup controllers.
 * @returns The controlled drawer while open, otherwise null.
 */
export function NovelContextOverlay({ contextController, setupController }: NovelContextOverlayProps) {
  const contextState = useSyncExternalStore(
    listener => contextController.subscribe(listener),
    () => contextController.getSnapshot(),
  )
  const setupState = useSyncExternalStore(
    listener => setupController.subscribe(listener),
    () => setupController.getSnapshot(),
  )
  const drawer = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!contextState.open || drawer.current === null) return
    return installDrawerKeyboardScope(
      drawer.current,
      closeButton.current ?? drawer.current,
      drawerReturnTargets.get(contextController),
      () => { contextController.close(); setupController.close() },
    )
  }, [contextController, contextState.open, setupController])
  if (!contextState.open) return null
  const close = (): void => { contextController.close(); setupController.close() }
  return (
    <div className="aiNovelContextOverlay" role="presentation">
      <div
        ref={drawer}
        className="aiNovelContextDrawer"
        role="dialog"
        aria-modal="false"
        aria-labelledby="ai-novel-context-title"
        tabIndex={-1}
      >
        <div className="aiNovelContextHeader">
          <h2 id="ai-novel-context-title">小说上下文</h2>
          <button
            ref={closeButton}
            type="button"
            className="aiNovelPresetClose"
            aria-label="关闭小说上下文"
            onClick={close}
          >关闭</button>
        </div>
        <div className="aiNovelContextBody" data-ai-novel-context>
          <NovelContextBody
            state={contextState}
            refresh={() => { void contextController.refresh() }}
            selectChapter={chapter => { void contextController.selectChapter(chapter) }}
          />
        </div>
        <section className="aiNovelContextSetup" aria-labelledby="ai-novel-preset-setup-title">
          <h3 id="ai-novel-preset-setup-title">AI 小说作家 Preset</h3>
          <PresetSetupBody
            state={setupState}
            install={() => { void setupController.install() }}
            retry={() => { void setupController.load() }}
          />
        </section>
      </div>
    </div>
  )
}
