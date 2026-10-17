import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { BookOpen, FileText, FileUp, RefreshCw, Search, X } from 'lucide-react'
import type { KBDocument } from '../../../services/knowledge-service'
import type { ModelProfile } from '../../../shared/ipc-channels'
import { countDraftUnits } from '../../../shared/draft-units'
import { registerEditorExitSaveHandler, useEditorStore, type KnowledgeDraft } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { EmptyState } from '../../ui/EmptyState'
import { Notice } from '../../ui/Notice'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { InkDialog } from '../InkDialog'
import { commandLabel } from '../shortcut-keys'
import { highlight } from './search-highlight'
import { EMPTY_DRAFT, isImportedDocument, useKnowledgeBase } from './use-knowledge-base'
import { pluralEn } from '../../../shared/plural-en'

type Shelf = 'imported' | 'chapters'

const TOP_K_OPTIONS = [5, 10, 20, 50] as const

function documentName(document: KBDocument): string {
  return document.fileName.replace(/\.[^.]+$/, '')
}

interface PendingExtraction {
  model: ModelProfile
  resolve: (send: boolean) => void
}

/**
 * 知识库：左列资料（导入的与定稿章节分开），中列所选资料的项目副本，右列在资料里查找。
 * 存储与检索方式不在这里出现；检索模型与索引检查在设置的检索模型页。
 * 所选资料与未保存的改动存在标签上：切走标签不丢，关标签与退出前走外壳统一的确认与保存。
 */
export default function StageKnowledge({ tabId }: { tabId: string }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const project = useProjectStore(s => s.currentProject)
  const tabDraft = useEditorStore(s => s.tabs.find(tab => tab.id === tabId)?.knowledgeDraft)
  const setTabDraft = useCallback((draft: KnowledgeDraft) => useEditorStore.getState().setKnowledgeDraft(tabId, draft), [tabId])
  const readTabDraft = useCallback(() => useEditorStore.getState().tabs.find(tab => tab.id === tabId)?.knowledgeDraft ?? EMPTY_DRAFT, [tabId])
  const kb = useKnowledgeBase([tabDraft ?? EMPTY_DRAFT, setTabDraft, readTabDraft])
  const { documents, stats, documentCopy, draftContent, dirty, documentBusy, searchResults, index } = kb
  const [shelf, setShelf] = useState<Shelf>('imported')
  const [pendingDocId, setPendingDocId] = useState<string | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [extraction, setExtraction] = useState<PendingExtraction | null>(null)
  const saveRef = useRef(kb.saveDocument)
  useEffect(() => { saveRef.current = kb.saveDocument })
  // 与正文编辑器一样，注册在页面卸载后仍保留，关标签时由编辑器仓库移除。
  useEffect(() => {
    registerEditorExitSaveHandler({ tabId, type: 'knowledge', save: () => saveRef.current() })
  }, [tabId])

  const imported = useMemo(() => documents.filter(isImportedDocument), [documents])
  const chapters = useMemo(() => documents.filter(document => !isImportedDocument(document))
    .sort((left, right) => (left.finalizedChapter ?? 0) - (right.finalizedChapter ?? 0)), [documents])
  const listed = shelf === 'imported' ? imported : chapters
  const emptyShelf = shelf === 'imported'
    ? text('还没有导入资料。', 'No material imported yet.')
    : text('定稿后，章节会自动收进这里。', 'Chapters are added here automatically once finalized.')
  const selected = documents.find(document => document.id === kb.selectedDocId) ?? null
  const selectedImported = selected !== null && isImportedDocument(selected)
  const pendingName = documents.find(document => document.id === pendingDocId)
  const hasMeaningSearch = stats.vectorDimension > 0
  const vectorless = index.status?.embeddingConfigured ? index.status.vectorlessCount : 0
  const loadError = kb.loadError || index.statusError
  // 最近一次读资料列表失败时，空列表与计数都不能当真。
  const documentsKnown = kb.documentsLoaded && !kb.loadError

  const pick = (docId: string) => {
    if (docId === kb.selectedDocId) return
    if (dirty) setPendingDocId(docId)
    else void kb.openDocument(docId)
  }

  const runSearch = (event: FormEvent) => {
    event.preventDefault()
    if (!kb.searchQuery.trim()) return
    void kb.search()
  }

  const clearSearch = () => {
    kb.setSearchQuery('')
    kb.clearResults()
  }

  const startImport = () => void kb.importPlanningMaterials(model => new Promise<boolean>(resolve => setExtraction({ model, resolve })))
  const answerExtraction = (send: boolean) => {
    extraction?.resolve(send)
    setExtraction(null)
  }

  const openSettings = () => navigate({ kind: 'settings', section: 'embedding' })

  return (
    <div className="stage-kb-frame">
      <div className="stage-kb">
        <nav className="stage-kb-col stage-kb-docs" aria-label={text('资料', 'Materials')}>
          <div className="stage-kb-head">
            <h1 className="stage-kb-title">{text('知识库', 'Knowledge base')}</h1>
            <Button variant="icon" size="sm" aria-label={text('刷新资料', 'Refresh materials')} onClick={() => void kb.reload()}>
              <RefreshCw size={14} aria-hidden="true" />
            </Button>
          </div>
          <p className="stage-kb-help">{text('写作和审稿时，AI 会从这里查找相关资料。', 'AI looks up related material here while writing and reviewing.')}</p>
          <Button variant="secondary" className="stage-kb-import" disabled={kb.importing} onClick={startImport}>
            <FileUp size={14} aria-hidden="true" />{kb.importing ? text('导入中…', 'Importing…') : text('导入创作资料', 'Import planning material')}
          </Button>
          <SegmentedControl<Shelf>
            label={text('资料来源', 'Material source')}
            value={shelf}
            onChange={setShelf}
            options={[
              { value: 'imported', label: documentsKnown ? text(`我导入的 ${imported.length}`, `Imported ${imported.length}`) : text('我导入的', 'Imported') },
              { value: 'chapters', label: documentsKnown ? text(`定稿章节 ${chapters.length}`, `Final chapters ${chapters.length}`) : text('定稿章节', 'Final chapters') },
            ]}
          />
          <ul className="stage-kb-list">
            {listed.map(document => (
              <li key={document.id}>
                <button
                  type="button"
                  className="stage-kb-doc"
                  aria-current={document.id === kb.selectedDocId ? 'true' : undefined}
                  onClick={() => pick(document.id)}
                >
                  {shelf === 'imported' ? <FileText size={14} aria-hidden="true" /> : <BookOpen size={14} aria-hidden="true" />}
                  <span>{documentName(document)}</span>
                </button>
              </li>
            ))}
            {listed.length === 0 && !kb.loadError && (
              <li className="stage-kb-help">{kb.documentsLoaded ? emptyShelf : text('正在读取…', 'Loading…')}</li>
            )}
          </ul>
          <div className="stage-kb-danger">
            <p>{text('清空全部资料与检索记录，之后需要重新导入。', 'Remove all material and its search records. You will need to import again.')}</p>
            <Button variant="danger" size="sm" disabled={kb.clearing || (stats.documentCount === 0 && stats.totalChunks === 0)} onClick={() => setClearOpen(true)}>
              {text('清空知识库…', 'Clear knowledge base…')}
            </Button>
          </div>
        </nav>

        <section className="stage-kb-col stage-kb-reader" aria-label={text('资料原文', 'Material text')}>
          {loadError && <Notice tone="danger" title={text('读取知识库失败', 'Could not read the knowledge base')}>{loadError}</Notice>}
          {!selected ? (
            !kb.documentsLoaded ? <p className="stage-kb-help stage-kb-hint" role="status">{text('正在读取资料…', 'Loading materials…')}</p>
            : kb.loadError ? null
            : documents.length === 0 ? (
              <EmptyState
                icon={<BookOpen />}
                heading={text('知识库里还没有资料', 'No material yet')}
                description={text('导入人物小传、设定笔记等创作资料，写作和审稿时 AI 会从这里查找；定稿的章节会自动收进来。', 'Import character notes, world notes and other material. AI looks things up here while writing and reviewing, and finalized chapters are added automatically.')}
                action={<Button variant="primary" disabled={kb.importing} onClick={startImport}>{text('导入创作资料', 'Import planning material')}</Button>}
              />
            ) : <p className="stage-kb-help stage-kb-hint">{text('从左边选一份资料查看原文。', 'Pick a material on the left to read it.')}</p>
          ) : (
            <>
              <header className="stage-kb-reader-head">
                <div className="stage-kb-eyebrow">{text('作品资料 · 知识库', 'Reference · Knowledge base')}</div>
                {selectedImported && documentCopy?.available && (
                  <div className="stage-kb-save">
                    {dirty && <span className="stage-kb-dirty">{text('有未保存的修改', 'Unsaved changes')}</span>}
                    <Button variant="primary" disabled={documentBusy || !dirty} onClick={() => void kb.saveDocument()} title={commandLabel('s')}>
                      {text('保存副本', 'Save copy')}
                    </Button>
                  </div>
                )}
              </header>
              <h2 className="stage-kb-doc-title">{documentName(selected)}</h2>
              {!selectedImported && (
                <Notice title={text('这一章由定稿自动收入', 'Added automatically when finalized')}>
                  {text('这里只能查看。要修改，请到正文里改这一章再定稿，新的定稿会另收一份。', 'You can only read it here. To change it, edit the chapter in the manuscript and finalize it again; the new version is added as a separate entry.')}
                </Notice>
              )}
              {!documentCopy ? <p className="stage-kb-help">{text('正在读取…', 'Loading…')}</p>
                : !documentCopy.available ? (
                  <Notice title={text('完整原文不可用', 'The full text is unavailable')}>
                    {text('这份资料的原文没有存进作品，不能在这里查看或修改；它仍能用来查找。', 'This material’s text was not stored in the book, so it cannot be read or edited here. It can still be searched.')}
                  </Notice>
                ) : !selectedImported ? (
                  <>
                    {documentCopy.edited && <p className="stage-kb-meta">{text('以前改过的项目副本', 'Previously edited project copy')}</p>}
                    <div className="stage-kb-editor stage-kb-original" role="document" aria-label={text('定稿原文', 'Finalized text')}>{documentCopy.content}</div>
                    {documentCopy.indexStatus === 'stale' && (
                      <Notice
                        tone="warn"
                        title={text('改动还没进入检索', 'Changes are not searchable yet')}
                        actions={<Button variant="secondary" size="sm" disabled={documentBusy} onClick={() => void kb.reindexDocument()}>{text('更新检索', 'Update search')}</Button>}
                      >
                        {text('这份副本以前改过，旧内容已不再参与检索和写作；更新后写作时就能查到上面的内容。', 'This copy was edited earlier, so its old text is no longer used for search or writing. Update to make the text above available.')}
                      </Notice>
                    )}
                  </>
                ) : <>
                  <p className="stage-kb-meta">
                    {documentCopy.edited ? text('已改过的项目副本', 'Edited project copy') : text('项目副本', 'Project copy')}
                    {' · '}{text(`${countDraftUnits(draftContent).toLocaleString(locale)} 字`, `${countDraftUnits(draftContent).toLocaleString(locale)} ${pluralEn(countDraftUnits(draftContent), 'word')}`)}
                    {' · '}{text('修改不会影响你电脑上的原文件', 'Edits never change the original file on your computer')}
                  </p>
                  <textarea
                    className="stage-kb-editor"
                    aria-label={text('项目副本内容', 'Project copy content')}
                    value={draftContent}
                    disabled={documentBusy}
                    onChange={event => kb.setDraftContent(event.target.value)}
                  />
                  {documentCopy.indexStatus === 'stale' ? (
                    <Notice
                      tone="warn"
                      title={text('改动还没进入检索', 'Changes are not searchable yet')}
                      actions={<Button variant="secondary" size="sm" disabled={documentBusy || dirty} onClick={() => void kb.reindexDocument()}>{text('更新检索', 'Update search')}</Button>}
                    >
                      {text('旧内容已不再参与检索和写作，更新后写作时就能查到新内容。', 'The old text is no longer used for search or writing. Update to make the new text available.')}
                    </Notice>
                  ) : <p className="stage-kb-help">{text('保存后需要更新检索，写作时才能查到新内容。', 'After saving, update search so writing can find the new text.')}</p>}
                </>}
            </>
          )}
        </section>

        <aside className="stage-kb-col stage-kb-search" aria-label={text('在资料里查找', 'Find in materials')}>
          <h2 className="stage-kb-search-title">{text('在资料里查找', 'Find in materials')}</h2>
          <form className="stage-kb-search-box" role="search" onSubmit={runSearch}>
            <Search size={14} aria-hidden="true" />
            <input
              className="stage-kb-search-input"
              aria-label={text('查找内容', 'Search text')}
              placeholder={text('人物、地点、事件……', 'People, places, events…')}
              value={kb.searchQuery}
              onChange={event => kb.setSearchQuery(event.target.value)}
            />
            {kb.searchQuery && (
              <Button variant="icon" size="sm" aria-label={text('清除查找', 'Clear search')} onClick={clearSearch}>
                <X size={13} aria-hidden="true" />
              </Button>
            )}
            <Button type="submit" variant="secondary" size="sm" disabled={kb.searching || !kb.searchQuery.trim()}>{text('查找', 'Find')}</Button>
          </form>
          <p className="stage-kb-help">
            {hasMeaningSearch
              ? text('可以按意思和字词查找。', 'Search by meaning and by words.')
              : <>{text('可以按字词查找。配置检索模型后，还能按意思查找。', 'Search by words. Set up a retrieval model to also search by meaning.')}{' '}
                <Button variant="text" size="sm" onClick={openSettings}>{text('去设置', 'Open settings')}</Button></>}
          </p>
          {vectorless > 0 && (
            <Notice
              tone="warn"
              title={text(`有 ${vectorless} 段资料还不能按意思查找`, `${vectorless} ${pluralEn(vectorless, 'passage')} cannot be searched by meaning yet`)}
              actions={<Button variant="secondary" size="sm" onClick={openSettings}>{text('去设置补全', 'Complete in settings')}</Button>}
            />
          )}
          {searchResults.length > 0 && (
            <div className="stage-kb-results-head">
              <span>{text(`找到 ${searchResults.length} 条`, `${searchResults.length} found`)}</span>
              <label>
                {text('最多显示', 'Show up to')}
                <select className="pi-input stage-kb-topk" value={kb.topK} onChange={event => kb.changeLimit(Number(event.target.value))}>
                  {TOP_K_OPTIONS.map(value => <option key={value} value={value}>{text(`${value} 条`, `${value}`)}</option>)}
                </select>
              </label>
            </div>
          )}
          {searchResults.length === 0 && kb.searchedQuery && !kb.searching && (
            <p className="stage-kb-help">{text('没有找到相关的资料。', 'Nothing related was found.')}</p>
          )}
          <ol className="stage-kb-results" aria-label={text('查找结果', 'Search results')}>
            {[...searchResults].reverse().map((result, position) => (
              <li key={position} className="stage-kb-result">
                <div className="stage-kb-result-source"><FileText size={12} aria-hidden="true" />{result.fileName.replace(/\.[^.]+$/, '')}</div>
                <p>{highlight(result.text, kb.searchedQuery)}</p>
              </li>
            ))}
          </ol>
        </aside>

        <DangerConfirm
          open={pendingDocId !== null}
          onOpenChange={open => { if (!open) setPendingDocId(null) }}
          title={text('放弃未保存的修改？', 'Discard unsaved changes?')}
          consequence={text(
            `「${selected ? documentName(selected) : ''}」的项目副本有未保存的修改，切换到「${pendingName ? documentName(pendingName) : ''}」后这些修改会丢失。`,
            `The project copy of “${selected ? documentName(selected) : ''}” has unsaved changes. Switching to “${pendingName ? documentName(pendingName) : ''}” discards them.`,
          )}
          recoverability={text(`丢弃后无法恢复。想保留就选「继续编辑」，再按 ${commandLabel('s')} 保存。`, `This cannot be undone. Choose “Keep editing” and press ${commandLabel('s')} to keep them.`)}
          confirmLabel={text('放弃并切换', 'Discard and switch')}
          cancelLabel={text('继续编辑', 'Keep editing')}
          onConfirm={() => { if (pendingDocId) void kb.openDocument(pendingDocId) }}
        />
        <DangerConfirm
          open={clearOpen}
          onOpenChange={setClearOpen}
          title={text('清空知识库？', 'Clear the knowledge base?')}
          consequence={text(
            '会删除这部作品已导入的全部资料和检索记录。正文、蓝图和故事架构不受影响。',
            'All imported material and search records of this book are removed. The manuscript, blueprint and story architecture are kept.',
          )}
          recoverability={text('清空后无法恢复，资料需要重新导入。', 'This cannot be undone. Material must be imported again.')}
          confirmLabel={text('清空知识库', 'Clear knowledge base')}
          cancelLabel={text('取消', 'Cancel')}
          onConfirm={() => {
            const session = captureProjectSession(project)
            if (session) void kb.clearAll(session)
          }}
        />
        <InkDialog
          open={extraction !== null}
          onOpenChange={open => { if (!open) answerExtraction(false) }}
          title={text('把资料发给模型提取角色卡？', 'Send the material to extract character cards?')}
          description={text('资料已存进这部作品的本地知识库。', 'The material is now stored in this book’s local knowledge base.')}
          footer={(
            <>
              <Button variant="secondary" onClick={() => answerExtraction(false)}>{text('取消', 'Cancel')}</Button>
              <Button variant="primary" onClick={() => answerExtraction(true)}>{text('发送并提取', 'Send and extract')}</Button>
            </>
          )}
        >
          <p className="pi-dialog-text">{text(
            `继续的话，本次选中的全部文字会发给「${extraction?.model.name ?? ''}」（${extraction?.model.modelName ?? ''}，${extraction?.model.baseUrl ?? ''}），用来提取可编辑的角色卡。`,
            `If you continue, all selected text is sent to “${extraction?.model.name ?? ''}” (${extraction?.model.modelName ?? ''}, ${extraction?.model.baseUrl ?? ''}) to extract editable character cards.`,
          )}</p>
        </InkDialog>
      </div>
    </div>
  )
}
