/** Pure React bodies for the compact workbench and its Plugin Configuration evidence card. */

import type { ChangeEvent } from 'react'
import type { PresetSetupState } from './setup-store.ts'
import type {
  NovelInitializationDraft,
  NovelWorkbenchState,
} from './workbench-store.ts'

/** Props for the one-column workbench content. */
export interface NovelWorkbenchBodyProps {
  readonly state: NovelWorkbenchState
  readonly refresh: () => void
  readonly selectChapter: (chapter: number) => void
  readonly updateInitialization: (patch: Partial<NovelInitializationDraft>) => void
  readonly previewInitialization: () => void
  readonly submitInitialization: () => void
}

function TextList({ items, empty }: { readonly items: readonly string[]; readonly empty: string }) {
  if (items.length === 0) return <p className="aiNovelContextMuted">{empty}</p>
  return <ul>{items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
}

function initializationField(
  label: string,
  name: keyof NovelInitializationDraft,
  value: string,
  update: (patch: Partial<NovelInitializationDraft>) => void,
  options: { readonly type?: 'text' | 'number'; readonly disabled?: boolean } = {},
) {
  const type = options.type ?? 'text'
  return (
    <label className="aiNovelWorkbenchField">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        disabled={options.disabled}
        value={value}
        min={type === 'number' ? 1 : undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { update({ [name]: event.currentTarget.value }) }}
      />
    </label>
  )
}

/**
 * Render the initialization tracer bullet and the existing bounded project summary.
 *
 * @param props Workbench state and user actions.
 * @returns Accessible one-column drawer content.
 */
export function NovelWorkbenchBody({
  state,
  refresh,
  selectChapter,
  updateInitialization,
  previewInitialization,
  submitInitialization,
}: NovelWorkbenchBodyProps) {
  switch (state.status) {
    case 'idle':
    case 'loading': return <p role="status">正在读取小说工作台…</p>
    case 'empty': return <p role="status">当前没有属于已注册工作区的会话。请先打开小说工作区中的会话。</p>
    case 'disconnected': return (
      <div role="alert">
        <p>Harness 连接已断开，恢复连接后才能读取或提交提案。</p>
        <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重新连接后读取</button>
      </div>
    )
    case 'error': return (
      <div role="alert">
        <p>小说工作台读取失败：{state.message}</p>
        <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重试读取</button>
      </div>
    )
    case 'not-initialized': {
      const { blocker, draft, phase, message, preview } = state.initialization
      const disabled = blocker !== undefined || phase === 'submitting' || phase === 'submitted'
      return (
        <form
          className="aiNovelWorkbenchForm"
          aria-labelledby="ai-novel-initialize-title"
          onSubmit={event => {
            event.preventDefault()
            if (preview === undefined) previewInitialization()
            else submitInitialization()
          }}
        >
          <div className="aiNovelWorkbenchIntro">
            <h3 id="ai-novel-initialize-title">初始化小说项目</h3>
            <p>填写项目设置后，工作台只会向当前会话发送一份初始化提案。文件仍需经过 Harness 原生审批才会创建。</p>
          </div>
          {initializationField('小说标题', 'title', draft.title, updateInitialization, { disabled })}
          {initializationField('语言', 'language', draft.language, updateInitialization, { disabled })}
          {initializationField('类型', 'genre', draft.genre, updateInitialization, { disabled })}
          {initializationField('计划章数', 'plannedChapters', draft.plannedChapters, updateInitialization, { type: 'number', disabled })}
          {initializationField(
            '每章目标字数', 'targetWordsPerChapter', draft.targetWordsPerChapter, updateInitialization,
            { type: 'number', disabled },
          )}
          <label className="aiNovelWorkbenchField">
            <span>创作策略</span>
            <select
              name="creativeStrategy"
              value={draft.creativeStrategy}
              disabled={disabled}
              onChange={event => { updateInitialization({ creativeStrategy: event.currentTarget.value as NovelInitializationDraft['creativeStrategy'] }) }}
            >
              <option value="auto">自动平衡</option>
              <option value="fluent-drafting">流畅起草</option>
              <option value="consistency-first">一致性优先</option>
              <option value="deep-planning">深度规划</option>
            </select>
          </label>
          {blocker !== undefined ? <p role="alert">{blocker}</p> : undefined}
          {phase === 'error' && message !== undefined ? <p role="alert">{message}</p> : undefined}
          {preview !== undefined ? (
            <section className="aiNovelInitializationPreview" aria-labelledby="ai-novel-initialization-preview-title">
              <h4 id="ai-novel-initialization-preview-title">即将提交的完整值</h4>
              <p>确认项目 ID、时间戳和设置无误后，再提交到当前会话。</p>
              <pre>{preview.json}</pre>
            </section>
          ) : undefined}
          {phase === 'submitted'
            ? <p role="status">初始化提案已发送。请回到对话查看并处理原生审批；批准后工作台会自动重新读取。</p>
            : undefined}
          {state.readFeedback !== undefined
            ? <p role={state.readFeedback.kind === 'error' || state.readFeedback.kind === 'disconnected' ? 'alert' : 'status'}>{state.readFeedback.message}</p>
            : undefined}
          <div className="aiNovelWorkbenchActions">
            <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重新读取</button>
            <button type="submit" className="aiNovelPresetPrimary" disabled={disabled}>
              {phase === 'submitting'
                ? '正在发送提案…'
                : preview === undefined ? '预览初始化提案' : '提交到当前会话'}
            </button>
          </div>
        </form>
      )
    }
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
                  onChange={event => { selectChapter(Number(event.currentTarget.value)) }}
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
          {state.readFeedback !== undefined ? <p role="status">{state.readFeedback.message}</p> : undefined}
        </div>
      )
    }
  }
}

/** Props for the Plugin Configuration evidence card. */
export interface NovelPluginCardBodyProps {
  readonly setupState: PresetSetupState
  readonly workbenchState: NovelWorkbenchState
  readonly openWorkbench: (returnFocus: HTMLButtonElement) => void
  readonly refresh: () => void
}

function hostStatus(state: PresetSetupState): string {
  return state.status === 'disconnected' ? 'Host 已断开' : 'Host 已连接'
}

function presetStatus(state: PresetSetupState): string {
  switch (state.status) {
    case 'installed': return 'Preset 已安装'
    case 'not-installed': return 'Preset 未安装'
    case 'conflict': return 'Preset 存在冲突'
    case 'disconnected': return 'Preset 状态不可用'
    case 'error': return 'Preset 检查失败'
    case 'idle':
    case 'loading': return '正在检查 Preset'
  }
}

function workspaceStatus(state: NovelWorkbenchState): string {
  return state.status === 'empty' || state.status === 'idle' ? 'Workspace 未选择' : 'Workspace 已选择'
}

function projectStatus(state: NovelWorkbenchState): string {
  switch (state.status) {
    case 'ready': return '项目已初始化'
    case 'not-initialized': return '项目未初始化'
    case 'loading': return '正在检查项目'
    case 'error': return '项目读取失败'
    case 'disconnected': return '项目状态不可用'
    case 'idle':
    case 'empty': return '项目尚不可用'
  }
}

/**
 * Render visible evidence that the browser plugin and its Host/Preset/project integrations are active.
 *
 * @param props Current setup and workbench state plus explicit actions.
 * @returns One Plugin Configuration list item.
 */
export function NovelPluginCardBody({
  setupState,
  workbenchState,
  openWorkbench,
  refresh,
}: NovelPluginCardBodyProps) {
  return (
    <li className="aiNovelPluginCard">
      <div className="aiNovelPluginCardHeader">
        <div><strong>AI 小说作家</strong><p>小说项目、专用 Preset 与审批式创作流程</p></div>
        <span className="aiNovelPluginMounted">Client 已挂载</span>
      </div>
      <dl className="aiNovelPluginFacts">
        <div><dt>Host</dt><dd>{hostStatus(setupState)}</dd></div>
        <div><dt>Preset</dt><dd>{presetStatus(setupState)}</dd></div>
        <div><dt>Workspace</dt><dd>{workspaceStatus(workbenchState)}</dd></div>
        <div><dt>小说项目</dt><dd>{projectStatus(workbenchState)}</dd></div>
      </dl>
      <div className="aiNovelPluginActions">
        <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>刷新状态</button>
        <button
          type="button"
          className="aiNovelPresetPrimary"
          onClick={event => { openWorkbench(event.currentTarget) }}
        >打开小说工作台</button>
      </div>
    </li>
  )
}
