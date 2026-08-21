/** Pure React bodies for the compact workbench and its Plugin Configuration evidence card. */

import type { ChangeEvent, ReactNode } from 'react'
import type { PresetSetupState } from './setup-store.ts'
import type {
  NovelCharacterDraft,
  NovelChapterBlueprintDraft,
  NovelAssetEditorScreen,
  NovelAssetEditorPhase,
  NovelProjectSettingsDraft,
  NovelStoryBlueprintDraft,
  NovelWorkbenchEditableTarget,
} from './asset-editor.ts'
import type { NovelInitializationDraft, NovelWorkbenchState } from './workbench-store.ts'
import type {
  NovelAggregateRef,
  NovelArtifact,
  NovelArtifactProposalChange,
  NovelChapterFinal,
  NovelProposalChange,
  NovelProposalItem,
  NovelProposalItemReceipt,
  NovelProposalStatus,
} from '../novel-store.ts'
import type { NovelV2WorkbenchState } from './workbench-v2.ts'

function proposalStatusLabel(status: NovelProposalStatus): string {
  return ({ pending: '待处理', partial: '部分已应用', stale: '冲突', applied: '已应用', discarded: '已放弃', superseded: '已替代', failed: '失败' })[status]
}

function taskStatusLabel(status: 'pending' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled'): string {
  return ({ pending: '等待', running: '进行中', blocked: '阻塞', succeeded: '完成', failed: '失败', cancelled: '已取消' })[status]
}

function aggregateLabel(target: NovelAggregateRef): string {
  if (target.kind === 'chapter') return `第 ${target.chapter} 章`
  if (target.kind === 'task') return `任务 ${target.taskId}`
  return ({ project: '项目设置', architecture: '故事架构', characters: '人物设定' })[target.kind]
}

function isArtifactProposalChange(change: NovelProposalChange | import('../novel-store.ts').NovelChangeSet): change is NovelArtifactProposalChange {
  return 'kind' in change && (change.kind === 'artifact/draft'
    || change.kind === 'artifact/review' || change.kind === 'artifact/revision' || change.kind === 'chapter/select-final')
}

function proposalCommandLabel(change: NovelArtifactProposalChange): string {
  return `${change.kind} · ${change.artifactId}`
}

function proposalReceiptLabel(receipt: NovelProposalItemReceipt): string {
  return 'globalRevision' in receipt
    ? `Host 收据：全局版本 ${receipt.globalRevision}`
    : `Host 收据：${receipt.kind} · 第 ${receipt.chapter} 章 · ${receipt.artifactId}`
}

function ArtifactCommandDiff({ command }: { readonly command: NovelArtifactProposalChange }) {
  const content = command.kind === 'artifact/review' ? command.report
    : command.kind === 'chapter/select-final' ? undefined : command.content
  return <section className="aiNovelV2CommandDiff" aria-label={`${proposalCommandLabel(command)} 命令差异`}>
    <h4>{proposalCommandLabel(command)} 命令差异</h4>
    <dl>
      <div><dt>章节</dt><dd>第 {command.chapter} 章</dd></div>
      {'parentArtifactId' in command ? <div><dt>父版本</dt><dd>{command.parentArtifactId}</dd></div> : undefined}
      {'parentArtifactId' in command ? undefined : command.kind === 'chapter/select-final'
        ? <div><dt>设为定稿</dt><dd>{command.artifactId}</dd></div>
        : undefined}
      <div><dt>摘要</dt><dd>{command.summary}</dd></div>
    </dl>
    {content === undefined ? undefined : <section>
      <h5>{command.kind === 'artifact/review' ? '审稿报告' : '正文'}</h5><pre>{content}</pre>
    </section>}
    <p className="aiNovelContextMuted">这是待审 proposal command；仅在 Host 应用 Proposal 后才会写入版本链。</p>
  </section>
}

function ProposalItemLifecycleActions({
  index,
  item,
  readOnly,
  available,
  retry,
  discard,
  regenerate,
}: {
  readonly index: number
  readonly item: NovelProposalItem
  readonly readOnly: boolean
  readonly available: boolean
  readonly retry: (index: number) => void
  readonly discard: (index: number) => void
  readonly regenerate: (index: number) => void
}) {
  return <div className="aiNovelWorkbenchActions aiNovelWorkbenchActionsInline" aria-label="Proposal 项恢复操作">
    <button type="button" onClick={() => { retry(index) }} disabled={!available || readOnly || item.status !== 'failed'}>重试此项</button>
    <button type="button" onClick={() => { discard(index) }}
      disabled={!available || readOnly || item.status === 'applied' || item.status === 'discarded' || item.status === 'superseded'}>放弃此项</button>
    <button type="button" onClick={() => { regenerate(index) }}
      disabled={!available || readOnly || item.status === 'applied' || item.status === 'superseded'}>重新生成</button>
  </div>
}

function ArtifactVersionChain({
  artifacts,
  final,
}: {
  readonly artifacts: readonly NovelArtifact[]
  readonly final: NovelChapterFinal | undefined
}) {
  return <section className="aiNovelV2ArtifactChain" aria-label="版本链">
    <h4>版本链</h4>
    {artifacts.length === 0 ? <p className="aiNovelContextMuted">本章还没有已应用的版本。</p> : <ol>
      {artifacts.map(artifact => <li key={artifact.artifactId}>
        <h5>{artifact.kind} · {artifact.artifactId}</h5>
        {artifact.parentArtifactId === undefined ? undefined : <p>父版本：{artifact.parentArtifactId}</p>}
        {artifact.content === undefined ? undefined : <section><h6>正文</h6><pre>{artifact.content}</pre></section>}
        {artifact.report === undefined ? undefined : <section><h6>审稿报告</h6><pre>{artifact.report}</pre></section>}
        <p>摘要：{artifact.summary}</p>
      </li>)}</ol>}
    {final === undefined ? <p className="aiNovelContextMuted">尚未选择定稿。</p>
      : <p><strong>已定稿</strong> · {final.artifactId} · {final.summary}</p>}
  </section>
}

/** Props for the V2 shell; every action remains client-local or path-free. */
export interface NovelV2WorkbenchBodyProps {
  readonly state: NovelV2WorkbenchState
  readonly refresh: () => void
  readonly selectProposal: (proposalId: string | undefined) => void
  readonly openProposalChange: (index: number) => void
  readonly applySelectedProposal: () => void
  readonly retryProposalItem: (index: number) => void
  readonly discardProposalItem: (index: number) => void
  readonly regenerateProposalItem: (index: number) => void
  readonly proposalLifecycleAvailable: boolean
  readonly selectTask: (taskId: string | undefined) => void
  readonly selectChapter: (chapter: number) => void
  readonly openAsset: (target: NovelAggregateRef) => void
  readonly updateEditor: (draft: string) => void
  readonly discardEditor: () => void
}

/**
 * V2 single-column shell. It renders Host projections and local draft state only;
 * command preview, commit, and task execution remain explicitly out of this issue.
 */
export function NovelV2WorkbenchBody({
  state, refresh, selectProposal, openProposalChange, applySelectedProposal,
  retryProposalItem, discardProposalItem, regenerateProposalItem, proposalLifecycleAvailable,
  selectTask, selectChapter, openAsset, updateEditor, discardEditor,
}: NovelV2WorkbenchBodyProps) {
  if (state.status === 'error') return <section className="aiNovelV2Workbench" data-ai-novel-v2-workbench>
      <h3 data-ai-novel-screen-focus tabIndex={-1}>工作台读取失败</h3>
      <p role="alert">{state.message}</p>
      <button type="button" onClick={refresh}>重试读取</button>
    </section>
  if (state.status !== 'ready') return state.status === 'idle'
    ? <p className="aiNovelContextMuted">请选择一个 Workspace 以打开小说工作台。</p>
    : <p className="aiNovelContextMuted" aria-live="polite">正在读取工作台状态…</p>

  const selectedProposal = state.proposals.items.find(item => item.proposalId === state.proposals.selectedId)
  const selectedTask = state.tasks.items.find(item => item.taskId === state.tasks.selectedId)
  const selectedItem = selectedProposal?.items[state.proposals.selectedChange ?? -1]
  const selectedChange = selectedItem?.change
  const editor = state.editor
  return <div className="aiNovelV2Workbench" data-ai-novel-v2-workbench>
    <section className="aiNovelV2Panel" aria-labelledby="ai-novel-v2-overview">
      <h3 id="ai-novel-v2-overview" data-ai-novel-screen-focus={editor.target === undefined ? '' : undefined} tabIndex={-1}>项目概览</h3>
      <dl className="aiNovelV2Summary">
        <div><dt>项目</dt><dd>{state.workspace.project.title}</dd></div>
        <div><dt>类型</dt><dd>{state.workspace.project.genre}</dd></div>
        <div><dt>版本</dt><dd>全局版本 {state.workspace.globalRevision}</dd></div>
        <div><dt>写入</dt><dd>{state.workspace.readOnly ? '只读' : '可用'}</dd></div>
      </dl>
    </section>

    <section className="aiNovelV2Panel" aria-labelledby="ai-novel-v2-proposals">
      <h3 id="ai-novel-v2-proposals">提案队列</h3>
      {state.proposals.message ? <p role="alert">{state.proposals.message}</p> : undefined}
      {state.proposals.items.length === 0 ? <p className="aiNovelContextMuted">没有待审提案。</p> : <ul className="aiNovelV2List">
        {state.proposals.items.map(proposal => <li key={proposal.proposalId}>
          <button type="button" aria-current={proposal.proposalId === state.proposals.selectedId || undefined}
            onClick={() => { selectProposal(proposal.proposalId) }}>
            {proposalStatusLabel(proposal.status)} · {proposal.items.length} 个聚合变更
          </button>
        </li>)}
      </ul>}
      {selectedProposal ? <div className="aiNovelV2DetailList" aria-label="提案变更">
        {selectedProposal.items.map((item, index) => {
          const change = item.change
          const artifactCommand = isArtifactProposalChange(change)
          return <div key={item.itemId}>
            <button type="button" aria-current={state.proposals.selectedChange === index || undefined}
              onClick={() => { openProposalChange(index) }}>
              {artifactCommand
                ? `#${item.itemOrder} · 查看 ${proposalCommandLabel(change)} 命令差异`
                : `#${item.itemOrder} · 查看 ${aggregateLabel(change.aggregate)} 差异 · 聚合版本 ${change.baseAggregateRevision} · 全局版本 ${change.baseGlobalRevision}`}
            </button>
            <span> {proposalStatusLabel(item.status)} · 尝试 {item.attemptCount} 次</span>
            {item.failure === undefined ? undefined : <p role="alert">失败：{item.failure}</p>}
            {item.receipt === undefined ? undefined : <p>{proposalReceiptLabel(item.receipt)}</p>}
            {item.regenerationTicket === undefined ? undefined : <p>Host 已保存重新生成请求。</p>}
            {artifactCommand ? <ArtifactCommandDiff command={change} /> : undefined}
            {artifactCommand && state.proposals.selectedChange === index ? <ProposalItemLifecycleActions
              index={index} item={item} readOnly={state.workspace.readOnly} available={proposalLifecycleAvailable}
              retry={retryProposalItem} discard={discardProposalItem} regenerate={regenerateProposalItem}
            /> : undefined}
          </div>
        })}
        <div className="aiNovelWorkbenchActions">
          <button type="button" onClick={applySelectedProposal}
            disabled={state.workspace.readOnly || selectedProposal.status === 'stale' || selectedProposal.status === 'discarded' || selectedProposal.status === 'superseded'}>
            依序应用未完成项
          </button>
        </div>
      </div> : undefined}
    </section>

    <section className="aiNovelV2Panel" aria-labelledby="ai-novel-v2-tasks">
      <h3 id="ai-novel-v2-tasks">任务</h3>
      {state.tasks.message ? <p role="alert">{state.tasks.message}</p> : undefined}
      {state.tasks.items.length === 0 ? <p className="aiNovelContextMuted">当前没有任务。</p> : <ul className="aiNovelV2List">
        {state.tasks.items.map(task => <li key={task.taskId}>
          <button type="button" aria-current={task.taskId === selectedTask?.taskId || undefined}
            onClick={() => { void selectTask(task.taskId) }}>
            {taskStatusLabel(task.status)} · {task.stage}
          </button>
          {task.failure !== '' ? <p role="alert">失败：{task.failure}</p> : undefined}
          {task.resumeCursor !== '' ? <p>可恢复：Host 已保存进度标记；此工作台仅显示状态。</p> : undefined}
        </li>)}
      </ul>}
    </section>

    <section className="aiNovelV2Panel" aria-labelledby="ai-novel-v2-assets">
      <h3 id="ai-novel-v2-assets">资产导航</h3>
      <div className="aiNovelV2AssetNav">
        <button type="button" onClick={() => { openAsset({ kind: 'project' }) }}>项目设置</button>
        <button type="button" onClick={() => { openAsset({ kind: 'architecture' }) }}>故事架构</button>
        <button type="button" onClick={() => { openAsset({ kind: 'characters' }) }}>人物设定</button>
        {state.chapters.items.map(chapter => <button type="button" key={chapter.chapter}
          aria-current={chapter.chapter === state.chapters.selected || undefined}
          onClick={() => {
            selectChapter(chapter.chapter)
            openAsset({ kind: 'chapter', chapter: chapter.chapter })
          }}>第 {chapter.chapter} 章：{chapter.title}</button>)}
      </div>
    </section>

    {(() => {
      const chapter = state.chapters.items.find(item => item.chapter === state.chapters.selected)
      if (chapter === undefined) return undefined
      const artifacts = (state.workspace.snapshot.artifacts ?? []).filter(item => item.chapter === chapter.chapter)
      const final = (state.workspace.snapshot.chapterFinals ?? []).find(item => item.chapter === chapter.chapter)
      const context = state.chapters.context ?? { phase: 'idle' as const, chapter: undefined, previousFinal: undefined, message: undefined }
      return <section className="aiNovelV2Panel" aria-labelledby="ai-novel-v2-chapter">
        <h3 id="ai-novel-v2-chapter">第 {chapter.chapter} 章蓝图</h3>
        <dl className="aiNovelV2Summary">
          <div><dt>标题</dt><dd>{chapter.title}</dd></div>
          <div><dt>目的</dt><dd>{chapter.purpose}</dd></div>
          <div><dt>状态</dt><dd>{chapter.status}</dd></div>
        </dl>
        <section aria-label={`第 ${chapter.chapter} 章情节节拍`}><h4>情节节拍</h4>
          {chapter.plotBeats.length === 0 ? <p className="aiNovelContextMuted">尚未记录情节节拍。</p> : <ul>{chapter.plotBeats.map(beat => <li key={beat}>{beat}</li>)}</ul>}
        </section>
        <section aria-label={`第 ${chapter.chapter} 章关键事件`}><h4>关键事件</h4>
          {chapter.keyEvents.length === 0 ? <p className="aiNovelContextMuted">尚未记录关键事件。</p> : <ul>{chapter.keyEvents.map(event => <li key={event}>{event}</li>)}</ul>}
        </section>
        <ArtifactVersionChain artifacts={artifacts} final={final} />
        <section className="aiNovelV2ChapterContext" aria-label={`第 ${chapter.chapter} 章的上一章定稿上下文`}>
          <h4>第 {chapter.chapter} 章的上一章定稿上下文</h4>
          {context.chapter !== chapter.chapter || context.phase === 'idle' ? <p className="aiNovelContextMuted">尚未读取本章上下文。</p>
            : context.phase === 'loading' ? <p className="aiNovelContextMuted" aria-live="polite">正在读取上一章定稿上下文…</p>
              : context.phase === 'failed' ? <p role="alert">上下文读取失败：{context.message}</p>
                : context.previousFinal === undefined ? <p className="aiNovelContextMuted">没有上一章已定稿内容可带入本章。</p>
                  : <><p>第 {context.previousFinal.chapter} 章 · {context.previousFinal.artifactId} · {context.previousFinal.summary}</p><pre>{context.previousFinal.content}</pre></>}
        </section>
      </section>
    })()}

    {editor.target === undefined ? undefined : <section className="aiNovelV2Panel aiNovelV2Editor" aria-labelledby="ai-novel-v2-editor">
       <h3 id="ai-novel-v2-editor" data-ai-novel-screen-focus="" tabIndex={-1}>{aggregateLabel(editor.target)}：编辑 / 差异 / 版本</h3>
      <p>当前全局版本 {state.workspace.globalRevision}；聚合版本 {editor.aggregateRevision ?? '未知'}。
        {editor.baseGlobalRevision === undefined ? undefined : ` 此详情基于全局版本 ${editor.baseGlobalRevision}。`}
        {editor.stale ? <span role="alert">权威值已更新：本地草稿保留为旧版本，保存前必须重新核对。</span> : undefined}
        {editor.message}
      </p>
      <div className="aiNovelV2Diff" aria-label="当前值与提案下一值差异">
        <section><h4>{editor.source === 'proposal' ? '本项提案基准值' : '当前值'}</h4><pre>{editor.current}</pre></section>
        {editor.next === undefined ? undefined : <section><h4>{editor.source === 'proposal' ? '提案下一值（本项基准 → 下一值）' : '提案下一值（当前 → 下一值）'}</h4><pre>{editor.next}</pre></section>}
      </div>
      <textarea aria-label={`${aggregateLabel(editor.target)} JSON 草稿`} value={editor.draft}
        onChange={event => { updateEditor(event.currentTarget.value) }} />
      <div className="aiNovelWorkbenchActions">
        <button type="button" disabled>保存（命令工作流待接入）</button>
        {editor.source !== 'proposal' || selectedChange === undefined ? <button type="button" disabled>应用（仅 Proposal Bundle 可应用）</button> : <>
          <button type="button" onClick={() => { retryProposalItem(state.proposals.selectedChange!) }}
            disabled={!proposalLifecycleAvailable || state.workspace.readOnly || selectedItem?.status !== 'failed'}>
            重试此项
          </button>
          <button type="button" onClick={() => { discardProposalItem(state.proposals.selectedChange!) }}
            disabled={!proposalLifecycleAvailable || state.workspace.readOnly || selectedItem?.status === 'applied' || selectedItem?.status === 'discarded' || selectedItem?.status === 'superseded'}>放弃此项</button>
          <button type="button" onClick={() => { regenerateProposalItem(state.proposals.selectedChange!) }}
            disabled={!proposalLifecycleAvailable || state.workspace.readOnly || selectedItem?.status === 'applied' || selectedItem?.status === 'superseded'}>重新生成</button>
        </>}
        <button type="button" onClick={discardEditor}>放弃本地草稿</button>
      </div>
      <p className="aiNovelContextMuted">Proposal Bundle 的顺序应用、失败停止、部分恢复与逐项生命周期均由 Host 负责；此界面只显示其权威状态与收据。</p>
    </section>}
  </div>
}

/** Props for the one-column workbench content. */
export interface NovelWorkbenchBodyProps {
  readonly state: NovelWorkbenchState
  readonly backIcon?: ReactNode
  readonly refresh: () => void
  readonly selectChapter: (chapter: number) => void
  readonly updateInitialization: (patch: Partial<NovelInitializationDraft>) => void
  readonly updateInitializationGenerationBrief: (brief: string) => void
  readonly generateInitialization: () => void
  readonly previewInitialization: () => void
  readonly submitInitialization: () => void
  readonly openAsset: (target: NovelWorkbenchEditableTarget) => void
  readonly backToAssets: () => void
  readonly updateProjectSettings: (patch: Partial<NovelProjectSettingsDraft>) => void
  readonly updateStoryBlueprint: (patch: Partial<NovelStoryBlueprintDraft>) => void
  readonly updateChapterBlueprint: (patch: Partial<NovelChapterBlueprintDraft>) => void
  readonly updateChapterDraft: (text: string) => void
  readonly updateAssetSummary: (summary: string) => void
  readonly updateAssetGenerationBrief: (brief: string) => void
  readonly generateAsset: () => void
  readonly previewAssetChange: () => void
  readonly submitAssetChange: () => void
  readonly discardAssetChanges: () => void
  readonly reloadStaleAsset: () => void
  readonly setCharacterSearch: (search: string) => void
  readonly selectCharacter: (id: string) => void
  readonly createCharacter: () => void
  readonly updateCharacter: (patch: Partial<Omit<NovelCharacterDraft, 'id'>>) => void
  readonly deleteCharacter: () => void
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

function characterField(
  label: string,
  name: keyof Omit<NovelCharacterDraft, 'id'>,
  value: string,
  update: (patch: Partial<Omit<NovelCharacterDraft, 'id'>>) => void,
) {
  return <label className="aiNovelWorkbenchField"><span>{label}</span><input
    value={value}
    onChange={event => { update({ [name]: event.currentTarget.value }) }}
  /></label>
}

interface CharacterRelationshipEditorRow {
  readonly characterId: string
  readonly type: string
  readonly summary: string
}

function relationshipRows(text: string): CharacterRelationshipEditorRow[] {
  if (text.trim() === '') return []
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map(line => {
    const [characterId = '', type = '', summary = ''] = line.split('|').map(part => part.trim())
    return { characterId, type, summary }
  })
}

function relationshipText(rows: readonly CharacterRelationshipEditorRow[]): string {
  return rows.map(row => `${row.characterId} | ${row.type} | ${row.summary}`).join('\n')
}

function CharacterRelationshipsEditor({
  selected,
  characters,
  update,
}: {
  readonly selected: NovelCharacterDraft
  readonly characters: readonly NovelCharacterDraft[]
  readonly update: (patch: Partial<Omit<NovelCharacterDraft, 'id'>>) => void
}) {
  const rows = relationshipRows(selected.relationshipsText)
  const candidates = characters.filter(character => character.id !== selected.id)
  const replaceRow = (index: number, patch: Partial<CharacterRelationshipEditorRow>): void => {
    update({ relationshipsText: relationshipText(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row)) })
  }
  return <fieldset className="aiNovelRelationshipEditor">
    <legend>人物关系</legend>
    {rows.length === 0 ? <p className="aiNovelContextMuted">尚未添加人物关系。</p> : rows.map((row, index) => <div className="aiNovelRelationshipRow" key={`${index}:${row.characterId}`}>
      <label className="aiNovelWorkbenchField"><span>关系人物 {index + 1}</span><select
        aria-label={`关系人物 ${index + 1}`}
        value={row.characterId}
        onChange={event => { replaceRow(index, { characterId: event.currentTarget.value }) }}
      >
        {candidates.some(character => character.id === row.characterId) ? undefined : <option value={row.characterId}>未找到的人物</option>}
        {candidates.map(character => <option value={character.id} key={character.id}>{character.name || '未命名人物'}{character.role === '' ? '' : ` · ${character.role}`}</option>)}
      </select></label>
      <label className="aiNovelWorkbenchField"><span>关系类型</span><input value={row.type} onChange={event => { replaceRow(index, { type: event.currentTarget.value }) }} /></label>
      <label className="aiNovelWorkbenchField"><span>关系说明</span><input value={row.summary} onChange={event => { replaceRow(index, { summary: event.currentTarget.value }) }} /></label>
      <button type="button" className="aiNovelPresetSecondary" onClick={() => { update({ relationshipsText: relationshipText(rows.filter((_row, rowIndex) => rowIndex !== index)) }) }}>删除关系</button>
    </div>)}
    <button
      type="button"
      className="aiNovelPresetSecondary"
      disabled={candidates.length === 0}
      onClick={() => { update({ relationshipsText: relationshipText([...rows, { characterId: candidates[0]!.id, type: '', summary: '' }]) }) }}
    >添加关系</button>
  </fieldset>
}

function ChapterCastEditor({
  characters,
  selectedIdsText,
  disabled,
  update,
}: {
  readonly characters: Extract<NovelWorkbenchState, { status: 'ready' }>['characters']
  readonly selectedIdsText: string
  readonly disabled: boolean
  readonly update: (characterIdsText: string) => void
}) {
  const selectedIds = selectedIdsText.split(/\r?\n/).map(id => id.trim()).filter(Boolean)
  const selected = new Set(selectedIds)
  const known = new Set(characters.map(character => character.id))
  const hiddenCount = selectedIds.filter(id => !known.has(id)).length
  return <fieldset className="aiNovelCastEditor" disabled={disabled}>
    <legend>出场人物</legend>
    {characters.length === 0 ? <p className="aiNovelContextMuted">请先建立人物设定。</p> : characters.map(character => <label key={character.id}>
      <input
        type="checkbox"
        checked={selected.has(character.id)}
        onChange={event => {
          const next = event.currentTarget.checked
            ? [...selectedIds, character.id]
            : selectedIds.filter(id => id !== character.id)
          update([...new Set(next)].join('\n'))
        }}
      />
      <span>{character.name || '未命名人物'}{character.role === '' ? '' : ` · ${character.role}`}</span>
    </label>)}
    {hiddenCount === 0 ? undefined : <p className="aiNovelContextMuted">已保留 {hiddenCount} 个当前人物列表中未显示的引用。</p>}
  </fieldset>
}

function AssetProposalFields({
  screen,
  disabled,
  updateSummary,
}: {
  readonly screen: NovelAssetEditorScreen
  readonly disabled: boolean
  readonly updateSummary: (summary: string) => void
}) {
  return <>
    <label className="aiNovelWorkbenchField"><span>修改摘要</span><textarea
      value={screen.summary}
      disabled={disabled}
      placeholder="说明本次单资产修改"
      onChange={event => { updateSummary(event.currentTarget.value) }}
    /></label>
    {screen.replacement === undefined ? undefined : <section className="aiNovelInitializationPreview" aria-label="即将提交的完整资产文本">
      <h4>即将提交的完整资产文本</h4>
      <p>审批前磁盘不会变化；提交后请回到对话处理原生 diff 审批。</p>
      <pre>{screen.replacement}</pre>
    </section>}
  </>
}

function AssetEditorFeedback({
  phase,
  message,
  reload,
}: {
  readonly phase: NovelAssetEditorPhase
  readonly message: string | undefined
  readonly reload: () => void
}) {
  if (message === undefined && phase !== 'submitted') return null
  if (phase === 'stale') return <div role="alert" className="aiNovelEditorNotice"><p>{message}</p><button type="button" className="aiNovelPresetSecondary" onClick={reload}>重新载入最新版本</button></div>
  return <p role={phase === 'error' ? 'alert' : 'status'}>{message ?? '修改提案已发送；请回到对话处理 Harness 原生审批。'}</p>
}

function assetEditorLocked(phase: NovelAssetEditorPhase): boolean {
  return phase === 'submitting' || phase === 'submitted' || phase === 'stale'
}

function generationLabel(screen: NovelAssetEditorScreen): string {
  switch (screen.kind) {
    case 'project': return '项目设置'
    case 'characters': return '人物设定'
    case 'story-blueprint': return '故事蓝图'
    case 'chapter-blueprint': return `第 ${screen.chapter} 章蓝图`
    case 'chapter-draft': return `第 ${screen.chapter} 章正文`
  }
}

function generationPending(screen: NovelAssetEditorScreen): boolean {
  return screen.generation?.phase === 'submitting'
    || screen.generation?.phase === 'submitted'
    || screen.generation?.phase === 'reconciling'
}

function AssetGenerationPanel({
  screen,
  blocker,
  updateBrief,
  generate,
}: {
  readonly screen: NovelAssetEditorScreen
  readonly blocker?: string
  readonly updateBrief: (brief: string) => void
  readonly generate: () => void
}) {
  const label = generationLabel(screen)
  const generation = screen.generation ?? { brief: '', phase: 'editing' as const }
  const pending = generationPending(screen)
  const manualBlocked = screen.phase !== 'clean' && screen.phase !== 'editing'
  return <section className="aiNovelGenerationPanel" aria-labelledby={`ai-novel-generate-${screen.kind}`}>
    <div className="aiNovelGenerationHeader">
      <h4 id={`ai-novel-generate-${screen.kind}`}>AI 生成{label}</h4>
      <p>只会生成当前资产，并通过对话展示原生审批。</p>
    </div>
    <p className="aiNovelContextMuted">原生审批就是对话中的单文件差异卡片。点击“允许一次”后会立即保存并回填本页字段，不会再出现第二次审批。</p>
    <label className="aiNovelWorkbenchField">
      <span>补充要求（可选）</span>
      <textarea
        aria-label={`${label} AI 生成要求`}
        value={generation.brief}
        disabled={pending}
        placeholder="例如：玄幻题材，主角林凡，保持现有世界观一致"
        onChange={event => { updateBrief(event.currentTarget.value) }}
      />
    </label>
    <p className="aiNovelContextMuted">留空时，模型会根据当前资产和项目上下文自动完善。</p>
    {screen.dirty && !manualBlocked && !pending
      ? <p className="aiNovelContextMuted">当前未提交表单会作为 AI 生成参考；模型结果仍需原生审批。</p>
      : undefined}
    {manualBlocked && !pending
      ? <p className="aiNovelContextMuted">当前手动修改已进入提案流程。请在底部提交手动修改到当前会话，或放弃修改后再生成。</p>
      : undefined}
    {blocker === undefined ? undefined : <p role="alert">{blocker}</p>}
    {generation.message !== undefined
      ? <p role={generation.phase === 'error' ? 'alert' : 'status'}>{generation.message}</p>
      : undefined}
    <button
      type="button"
      className="aiNovelPresetSecondary aiNovelGenerationButton"
      disabled={blocker !== undefined || pending || manualBlocked}
      onClick={generate}
    >{generation.phase === 'submitting' ? '正在发送生成请求…' : '让当前模型生成'}</button>
  </section>
}

function AssetEditorHeading({
  title,
  detail,
  back,
  blocked,
  icon,
}: {
  readonly title: string
  readonly detail: string
  readonly back: () => void
  readonly blocked: boolean
  readonly icon: ReactNode
}) {
  return <div className="aiNovelAssetHeading">
    <button type="button" className="aiNovelBackButton" aria-label="返回小说资产列表" disabled={blocked} onClick={back}>
      {icon}<span>返回小说资产</span>
    </button>
    <div><h3 data-ai-novel-screen-focus tabIndex={-1}>{title}</h3><p>{detail}</p></div>
  </div>
}

function AssetEditorActions({
  dirty,
  phase,
  hasPreview,
  refresh,
  discard,
}: {
  readonly dirty: boolean
  readonly phase: NovelAssetEditorPhase
  readonly hasPreview: boolean
  readonly refresh: () => void
  readonly discard: () => void
}) {
  const locked = assetEditorLocked(phase)
  return <div className="aiNovelWorkbenchActions">
    <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重新读取</button>
    <button type="button" className="aiNovelPresetSecondary" disabled={!dirty || locked} onClick={discard}>放弃修改</button>
    <button type="submit" className="aiNovelPresetPrimary" disabled={!dirty || locked}>
      {phase === 'submitting' ? '正在发送提案…' : hasPreview ? '提交手动修改到当前会话' : '预览手动修改'}
    </button>
  </div>
}

/**
 * Render the initialization tracer bullet and the existing bounded project summary.
 *
 * @param props Workbench state and user actions.
 * @returns Accessible one-column drawer content.
 */
export function NovelWorkbenchBody({
  state,
  backIcon,
  refresh,
  selectChapter,
  updateInitialization,
  updateInitializationGenerationBrief,
  generateInitialization,
  previewInitialization,
  submitInitialization,
  openAsset,
  backToAssets,
  updateProjectSettings,
  updateStoryBlueprint,
  updateChapterBlueprint,
  updateChapterDraft,
  updateAssetSummary,
  updateAssetGenerationBrief,
  generateAsset,
  previewAssetChange,
  submitAssetChange,
  discardAssetChanges,
  reloadStaleAsset,
  setCharacterSearch,
  selectCharacter,
  createCharacter,
  updateCharacter,
  deleteCharacter,
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
      const generation = state.initialization.generation ?? { brief: '', phase: 'editing' as const }
      const generationPending = generation.phase === 'submitting'
        || generation.phase === 'submitted'
        || generation.phase === 'reconciling'
      const manuallyEdited = draft.title !== '' || draft.language !== 'zh-CN' || draft.genre !== ''
        || draft.plannedChapters !== '20' || draft.targetWordsPerChapter !== '3000' || draft.creativeStrategy !== 'auto'
      const disabled = blocker !== undefined || phase === 'submitting' || phase === 'submitted' || generationPending
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
          <section className="aiNovelGenerationPanel" aria-labelledby="ai-novel-generate-initialization">
            <div className="aiNovelGenerationHeader">
              <h4 id="ai-novel-generate-initialization">AI 生成项目设置</h4>
              <p>描述题材与主角，当前模型会生成一份初始化提案，并通过对话展示原生审批。</p>
            </div>
            <p className="aiNovelContextMuted">原生审批就是对话中的单文件差异卡片。点击“允许一次”后会创建项目并回填本页字段，不会再出现第二次审批。</p>
            <label className="aiNovelWorkbenchField"><span>生成要求（可选）</span><textarea
              aria-label="项目设置 AI 生成要求"
              value={generation.brief}
              disabled={generationPending}
              placeholder="例如：玄幻题材，主角林凡，规划 12 章"
              onChange={event => { updateInitializationGenerationBrief(event.currentTarget.value) }}
            /></label>
            <p className="aiNovelContextMuted">留空时，模型会根据当前表单和默认项目规模自动生成。</p>
            {manuallyEdited && !generationPending
              ? <p className="aiNovelContextMuted">当前手填项目设置会作为 AI 生成参考；模型结果仍需原生审批。</p>
              : undefined}
            {generation.message === undefined ? undefined
              : <p role={generation.phase === 'error' ? 'alert' : 'status'}>{generation.message}</p>}
            <button
              type="button"
              className="aiNovelPresetSecondary aiNovelGenerationButton"
              disabled={blocker !== undefined || generationPending}
              onClick={generateInitialization}
            >{generation.phase === 'submitting' ? '正在发送生成请求…' : '让当前模型生成'}</button>
          </section>
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
          {message !== undefined ? <p role={phase === 'error' ? 'alert' : 'status'}>{message}</p> : undefined}
          {preview !== undefined ? (
            <section className="aiNovelInitializationPreview" aria-labelledby="ai-novel-initialization-preview-title">
              <h4 id="ai-novel-initialization-preview-title">即将提交的完整值</h4>
              <p>项目 ID 与时间戳由插件自动生成；确认可读的小说设置后，再提交到当前会话。</p>
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
      const screen = state.screen
      if (screen.kind === 'asset-loading') return <p role="status">正在读取资产的精确 revision…</p>
      if (screen.kind === 'asset-error') return (
        <div role="alert" className="aiNovelWorkbenchForm">
          <p>资产读取失败：{screen.message}</p>
          <div className="aiNovelWorkbenchActions aiNovelWorkbenchActionsInline">
            <button type="button" className="aiNovelPresetSecondary" onClick={backToAssets}>返回资产</button>
            <button type="button" className="aiNovelPresetPrimary" onClick={() => { openAsset(screen.target) }}>重试</button>
          </div>
        </div>
      )
      if (screen.kind === 'project') {
        const disabled = assetEditorLocked(screen.phase) || generationPending(screen)
        return (
          <form className="aiNovelWorkbenchForm" onSubmit={event => { event.preventDefault(); screen.preview === undefined ? previewAssetChange() : submitAssetChange() }}>
            <AssetEditorHeading title="项目设置" detail={`基于 revision ${screen.baseRevision.slice(0, 12)}`} back={backToAssets} blocked={screen.dirty || disabled} icon={backIcon} />
            {initializationField('小说标题', 'title', screen.draft.title, updateProjectSettings, { disabled })}
            {initializationField('语言', 'language', screen.draft.language, updateProjectSettings, { disabled })}
            {initializationField('类型', 'genre', screen.draft.genre, updateProjectSettings, { disabled })}
            {initializationField('计划章数', 'plannedChapters', screen.draft.plannedChapters, updateProjectSettings, { type: 'number', disabled })}
            {initializationField('每章目标字数', 'targetWordsPerChapter', screen.draft.targetWordsPerChapter, updateProjectSettings, { type: 'number', disabled })}
            <label className="aiNovelWorkbenchField"><span>创作策略</span><select
              value={screen.draft.creativeStrategy}
              disabled={disabled}
              onChange={event => { updateProjectSettings({ creativeStrategy: event.currentTarget.value as NovelProjectSettingsDraft['creativeStrategy'] }) }}
            ><option value="auto">自动平衡</option><option value="fluent-drafting">流畅起草</option><option value="consistency-first">一致性优先</option><option value="deep-planning">深度规划</option></select></label>
            <AssetGenerationPanel screen={screen} blocker={state.submissionBlocker} updateBrief={updateAssetGenerationBrief} generate={generateAsset} />
            <AssetProposalFields screen={screen} disabled={disabled} updateSummary={updateAssetSummary} />
            <AssetEditorFeedback phase={screen.phase} message={screen.message} reload={reloadStaleAsset} />
            <AssetEditorActions
              dirty={screen.dirty} phase={screen.phase} hasPreview={screen.preview !== undefined}
              refresh={refresh} discard={discardAssetChanges}
            />
          </form>
        )
      }
      if (screen.kind === 'characters') {
        const selected = screen.characters.find(character => character.id === screen.selectedId)
        const disabled = assetEditorLocked(screen.phase) || generationPending(screen)
        return (
          <form className="aiNovelWorkbenchForm" onSubmit={event => { event.preventDefault(); screen.preview === undefined ? previewAssetChange() : submitAssetChange() }}>
            <AssetEditorHeading title="人物设定" detail={`${screen.characters.length} 人 · revision ${screen.baseRevision.slice(0, 12)}`} back={backToAssets} blocked={screen.dirty || disabled} icon={backIcon} />
            <div className="aiNovelCharacterToolbar">
              <label className="aiNovelWorkbenchField"><span>搜索人物</span><input value={screen.search} onChange={event => { setCharacterSearch(event.currentTarget.value) }} /></label>
              <button type="button" className="aiNovelPresetSecondary" disabled={disabled} onClick={createCharacter}>新建人物</button>
            </div>
            {screen.visibleCharacterIds.length === 0
              ? <p className="aiNovelContextMuted">没有匹配的人物。</p>
              : <ul className="aiNovelCharacterList" aria-label="人物列表">{screen.visibleCharacterIds.map(id => {
                  const character = screen.characters.find(item => item.id === id)!
                  return <li key={id}><button type="button" aria-current={id === screen.selectedId} onClick={() => { selectCharacter(id) }}><strong>{character.name || '未命名人物'}</strong><span>{character.role || '角色未填写'}</span></button></li>
                })}</ul>}
            {selected === undefined ? <p className="aiNovelContextMuted">选择或新建人物后编辑完整设定。</p> : <fieldset className="aiNovelCharacterEditor" disabled={disabled}>
              <legend>{selected.name || '新人物'}</legend>
              {characterField('姓名', 'name', selected.name, updateCharacter)}
              {characterField('角色', 'role', selected.role, updateCharacter)}
              {characterField('摘要', 'summary', selected.summary, updateCharacter)}
              {characterField('目标', 'goal', selected.goal, updateCharacter)}
              <CharacterRelationshipsEditor selected={selected} characters={screen.characters} update={updateCharacter} />
              <label className="aiNovelWorkbenchField"><span>备注</span><textarea value={selected.notes} onChange={event => { updateCharacter({ notes: event.currentTarget.value }) }} /></label>
              <button type="button" className="aiNovelDangerButton" onClick={deleteCharacter}>删除此人物</button>
            </fieldset>}
            <AssetGenerationPanel screen={screen} blocker={state.submissionBlocker} updateBrief={updateAssetGenerationBrief} generate={generateAsset} />
            <AssetProposalFields screen={screen} disabled={disabled} updateSummary={updateAssetSummary} />
            <AssetEditorFeedback phase={screen.phase} message={screen.message} reload={reloadStaleAsset} />
            <AssetEditorActions dirty={screen.dirty} phase={screen.phase} hasPreview={screen.preview !== undefined} refresh={refresh} discard={discardAssetChanges} />
          </form>
        )
      }
      if (screen.kind === 'story-blueprint') {
        const disabled = assetEditorLocked(screen.phase) || generationPending(screen)
        return (
          <form className="aiNovelWorkbenchForm" onSubmit={event => { event.preventDefault(); screen.preview === undefined ? previewAssetChange() : submitAssetChange() }}>
            <AssetEditorHeading title="故事蓝图" detail={`revision ${screen.baseRevision.slice(0, 12)}`} back={backToAssets} blocked={screen.dirty || disabled} icon={backIcon} />
            <label className="aiNovelWorkbenchField"><span>故事前提</span><textarea disabled={disabled} value={screen.draft.premise} onChange={event => { updateStoryBlueprint({ premise: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>主题（每行一项）</span><textarea disabled={disabled} value={screen.draft.themesText} onChange={event => { updateStoryBlueprint({ themesText: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>世界设定</span><textarea disabled={disabled} value={screen.draft.world} onChange={event => { updateStoryBlueprint({ world: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>故事主线</span><textarea disabled={disabled} value={screen.draft.mainPlot} onChange={event => { updateStoryBlueprint({ mainPlot: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>结局目标</span><textarea disabled={disabled} value={screen.draft.endingGoal} onChange={event => { updateStoryBlueprint({ endingGoal: event.currentTarget.value }) }} /></label>
            <AssetGenerationPanel screen={screen} blocker={state.submissionBlocker} updateBrief={updateAssetGenerationBrief} generate={generateAsset} />
            <AssetProposalFields screen={screen} disabled={disabled} updateSummary={updateAssetSummary} />
            <AssetEditorFeedback phase={screen.phase} message={screen.message} reload={reloadStaleAsset} />
            <AssetEditorActions dirty={screen.dirty} phase={screen.phase} hasPreview={screen.preview !== undefined} refresh={refresh} discard={discardAssetChanges} />
          </form>
        )
      }
      if (screen.kind === 'chapter-blueprint') {
        const disabled = assetEditorLocked(screen.phase) || generationPending(screen)
        return (
          <form className="aiNovelWorkbenchForm" onSubmit={event => { event.preventDefault(); screen.preview === undefined ? previewAssetChange() : submitAssetChange() }}>
            <AssetEditorHeading title={`第 ${screen.chapter} 章蓝图`} detail={`revision ${screen.baseRevision.slice(0, 12)}`} back={backToAssets} blocked={screen.dirty || disabled} icon={backIcon} />
            <label className="aiNovelWorkbenchField"><span>章节标题</span><input disabled={disabled} value={screen.draft.title} onChange={event => { updateChapterBlueprint({ title: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>章节目的</span><textarea disabled={disabled} value={screen.draft.purpose} onChange={event => { updateChapterBlueprint({ purpose: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>情节节拍（每行一项）</span><textarea disabled={disabled} value={screen.draft.beatsText} onChange={event => { updateChapterBlueprint({ beatsText: event.currentTarget.value }) }} /></label>
            <ChapterCastEditor
              characters={state.characters}
              selectedIdsText={screen.draft.characterIdsText}
              disabled={disabled}
              update={characterIdsText => { updateChapterBlueprint({ characterIdsText }) }}
            />
            <label className="aiNovelWorkbenchField"><span>连续性备注（每行一项）</span><textarea disabled={disabled} value={screen.draft.continuityNotesText} onChange={event => { updateChapterBlueprint({ continuityNotesText: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>章节状态</span><select disabled={disabled} value={screen.draft.status} onChange={event => { updateChapterBlueprint({ status: event.currentTarget.value as NovelChapterBlueprintDraft['status'] }) }}><option value="planned">已规划</option><option value="drafting">起草中</option><option value="drafted">已起草</option><option value="revised">已修订</option><option value="final">已定稿</option></select></label>
            <AssetGenerationPanel screen={screen} blocker={state.submissionBlocker} updateBrief={updateAssetGenerationBrief} generate={generateAsset} />
            <AssetProposalFields screen={screen} disabled={disabled} updateSummary={updateAssetSummary} />
            <AssetEditorFeedback phase={screen.phase} message={screen.message} reload={reloadStaleAsset} />
            <AssetEditorActions dirty={screen.dirty} phase={screen.phase} hasPreview={screen.preview !== undefined} refresh={refresh} discard={discardAssetChanges} />
          </form>
        )
      }
      if (screen.kind === 'chapter-draft') {
        const disabled = assetEditorLocked(screen.phase) || generationPending(screen)
        return (
          <form className="aiNovelWorkbenchForm" onSubmit={event => { event.preventDefault(); screen.preview === undefined ? previewAssetChange() : submitAssetChange() }}>
            <AssetEditorHeading title={`第 ${screen.chapter} 章正文`} detail={`Markdown · revision ${screen.baseRevision.slice(0, 12)}`} back={backToAssets} blocked={screen.dirty || disabled} icon={backIcon} />
            <label className="aiNovelWorkbenchField"><span>章节正文 Markdown</span><textarea
              className="aiNovelChapterDraftEditor"
              aria-label="章节正文 Markdown"
              disabled={disabled}
              value={screen.text}
              onChange={event => { updateChapterDraft(event.currentTarget.value) }}
            /></label>
            <AssetGenerationPanel screen={screen} blocker={state.submissionBlocker} updateBrief={updateAssetGenerationBrief} generate={generateAsset} />
            <AssetProposalFields screen={screen} disabled={disabled} updateSummary={updateAssetSummary} />
            <AssetEditorFeedback phase={screen.phase} message={screen.message} reload={reloadStaleAsset} />
            <AssetEditorActions dirty={screen.dirty} phase={screen.phase} hasPreview={screen.preview !== undefined} refresh={refresh} discard={discardAssetChanges} />
          </form>
        )
      }
      const blueprint = state.chapterBlueprint
      return (
        <div className="aiNovelContextSections">
          <section aria-labelledby="ai-novel-assets">
            <div className="aiNovelContextSectionHeader"><h3 id="ai-novel-assets" data-ai-novel-screen-focus tabIndex={-1}>小说资产</h3><button type="button" className="aiNovelPresetSecondary" onClick={refresh}>刷新</button></div>
            <div className="aiNovelAssetList">
              <button type="button" onClick={() => { openAsset({ kind: 'project' }) }}><strong>项目设置</strong><span>标题、语言、类型、规模与创作策略</span></button>
              <button type="button" onClick={() => { openAsset({ kind: 'characters' }) }}><strong>人物设定</strong><span>{state.characters.length === 0 ? '尚未建立人物表' : `${state.characters.length} 个人物`}</span></button>
              <button type="button" onClick={() => { openAsset({ kind: 'story-blueprint' }) }}><strong>故事蓝图</strong><span>{state.storyBlueprint === null ? '尚未建立' : '前提、主题、世界与主线'}</span></button>
              <button type="button" onClick={() => { openAsset({ kind: 'chapter-blueprint', chapter: state.progress.selectedChapter }) }}><strong>章节蓝图</strong><span>第 {state.progress.selectedChapter} 章的目的、节拍与连续性</span></button>
              <button type="button" onClick={() => { openAsset({ kind: 'chapter-draft', chapter: state.progress.selectedChapter }) }}><strong>章节正文</strong><span>{state.progress.draftPresent ? `${state.progress.draftBytes} 字节` : `第 ${state.progress.selectedChapter} 章尚未创建`}</span></button>
            </div>
          </section>
          <section aria-labelledby="ai-novel-project-summary">
            <div className="aiNovelContextSectionHeader">
              <h3 id="ai-novel-project-summary">{state.project.title}</h3>
            </div>
            <dl className="aiNovelContextFacts">
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
          {state.readFeedback !== undefined
            ? <p role={state.readFeedback.kind === 'error' || state.readFeedback.kind === 'disconnected' ? 'alert' : 'status'}>{state.readFeedback.message}</p>
            : undefined}
        </div>
      )
    }
  }
}

/** Props for the Plugin Configuration evidence card. */
export interface NovelPluginCardBodyProps {
  readonly setupState: PresetSetupState
  readonly workbenchState: NovelWorkbenchState | NovelV2WorkbenchState | undefined
  readonly workbenchMode: 'none' | 'v1' | 'v2'
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

function workspaceStatus(state: NovelWorkbenchState | NovelV2WorkbenchState | undefined, mode: 'none' | 'v1' | 'v2'): string {
  if (mode === 'none' || state === undefined) return '未绑定小说会话'
  if (mode === 'v2') {
    if (state.status === 'ready') return 'Workspace 已选择'
    if (state.status === 'loading') return '正在检查 Workspace'
    if (state.status === 'error') return 'Workspace 状态不可用'
    return 'Workspace 未选择'
  }
  const v1 = state as NovelWorkbenchState
  return v1.status === 'empty' || v1.status === 'idle' ? 'Workspace 未选择' : 'Workspace 已选择'
}

function projectStatus(state: NovelWorkbenchState | NovelV2WorkbenchState | undefined, mode: 'none' | 'v1' | 'v2'): string {
  if (mode === 'none' || state === undefined) return '请在当前会话选择 AI 小说作家 Preset'
  if (mode === 'v2') {
    if (state.status === 'ready') return '项目已加载（V2）'
    if (state.status === 'loading') return '正在检查项目'
    if (state.status === 'error') return state.message.includes('连接已断开') ? '项目状态不可用' : '项目读取失败'
    return '项目尚不可用'
  }
  const v1 = state as NovelWorkbenchState
  switch (v1.status) {
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
  workbenchMode,
  openWorkbench,
  refresh,
}: NovelPluginCardBodyProps) {
  return (
    <li className="aiNovelPluginCard">
      <div className="aiNovelPluginCardHeader">
        <div><strong>AI 小说作家</strong><p>{workbenchMode === 'v2' ? 'V2 单列工作台与只读项目投影' : workbenchMode === 'v1' ? '小说项目、专用 Preset 与审批式创作流程' : '当前会话未绑定小说 Preset，不会打开小说工作台。'}</p></div>
        <span className="aiNovelPluginMounted">Client 已挂载</span>
      </div>
      <dl className="aiNovelPluginFacts">
        <div><dt>Host</dt><dd>{hostStatus(setupState)}</dd></div>
        <div><dt>Preset</dt><dd>{presetStatus(setupState)}</dd></div>
        <div><dt>工作台</dt><dd>{workbenchMode === 'v2' ? 'V2 单列工作台' : workbenchMode === 'v1' ? 'V1 紧凑编辑器' : '未绑定小说会话'}</dd></div>
        <div><dt>Workspace</dt><dd>{workspaceStatus(workbenchState, workbenchMode)}</dd></div>
        <div><dt>小说项目</dt><dd>{projectStatus(workbenchState, workbenchMode)}</dd></div>
      </dl>
      <div className="aiNovelPluginActions">
        <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>刷新状态</button>
        <button
          type="button"
          className="aiNovelPresetPrimary"
          disabled={workbenchMode === 'none'}
          onClick={event => { openWorkbench(event.currentTarget) }}
        >打开小说工作台</button>
      </div>
    </li>
  )
}
