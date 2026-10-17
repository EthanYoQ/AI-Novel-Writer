import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { getVectorRebuildPresentation } from '../../pages/knowledge-rebuild-presentation'
import { Button } from '../../ui/Button'
import { useKnowledgeIndex } from './use-knowledge-base'
import { pluralEn } from '../../../shared/plural-en'

/**
 * 设置「检索模型」页里的索引检查与重建。知识库页不放这项实现细节（ia.md「实现细节不进入创作界面」）。
 */
export default function KnowledgeIndexSection() {
  const text = useLocaleStore(s => s.text)
  const project = useProjectStore(s => s.currentProject)
  const { status, statusError, backfilling, loadStatus, backfill } = useKnowledgeIndex()
  const presentation = getVectorRebuildPresentation(status)
  const description = !project
    ? text('打开一部作品后，可以在这里检查它的检索索引。', 'Open a book to check its search index here.')
    : !presentation
      ? text('配置并启用检索模型后，可以在这里检查和补全当前作品的检索索引。', 'Once a retrieval model is set up, check and complete the current book’s search index here.')
      : presentation.kind === 'missing-vectors'
        ? text(`当前作品有 ${status!.vectorlessCount} 段资料还没有按检索模型建立索引；检查后会安全补全或重建。`, `${status!.vectorlessCount} ${pluralEn(status!.vectorlessCount, 'passage')} of the current book ${pluralEn(status!.vectorlessCount, 'is', 'are')} not indexed for the retrieval model yet. The check completes or rebuilds the index safely.`)
        : text('换了检索模型后，用一段本地资料确认它的索引是否需要重建；需要时先完整建好新索引再切换。', 'After changing the retrieval model, one local passage confirms whether the index must be rebuilt. If so, a complete new index is built before search switches.')

  return (
    <section className="stage-set-rows" aria-label={text('当前作品的检索索引', 'Search index of the current book')}>
      <div className="stage-set-row">
        <div>
          <h3 className="stage-set-row-title">
            {presentation ? text(presentation.title.zhCN, presentation.title.enUS) : text('当前作品的检索索引', 'Search index of the current book')}
          </h3>
          <p className="stage-set-row-desc">{description}</p>
          {statusError && <p role="alert" className="stage-set-error">{statusError}</p>}
        </div>
        {presentation && (
          <div className="stage-set-row-ctl">
            <Button variant="secondary" size="sm" disabled={backfilling} aria-busy={backfilling || undefined} onClick={() => void backfill().then(loadStatus)}>
              {backfilling ? text('检查与重建中…', 'Checking and rebuilding…') : text(presentation.action.zhCN, presentation.action.enUS)}
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
