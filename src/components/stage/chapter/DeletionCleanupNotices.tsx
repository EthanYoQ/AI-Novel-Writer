import { useLocaleStore } from '../../../stores/locale-store'
import { useIncompleteDeletions } from '../../panels/sidebar/use-incomplete-deletions'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'

/**
 * 删除这一章的正文后没做完的清理：可以重试，旧定稿要先人工核对知识投影。
 * 待写视图与这一章其余未定稿的稿都挂着它，删除提示说的「这一章的页面」无论落在哪一种上都有入口。
 */
export default function DeletionCleanupNotices({ projectKey, chapterNumber }: { projectKey: string; chapterNumber: number }) {
  const text = useLocaleStore(s => s.text)
  const deletions = useIncompleteDeletions(projectKey)
  return deletions.operations.filter(operation => operation.chapterNumber === chapterNumber).map(operation => {
    const manual = operation.legacyKnowledgeAuthorization === 'required'
    return (
      <Notice
        key={operation.operationId}
        tone="warn"
        title={manual ? text('删除正文后待人工核对知识投影', 'The deleted manuscript needs a manual knowledge check') : text('删除正文后的清理没有完成', 'Cleanup after deleting the manuscript is unfinished')}
        actions={(
          <Button variant="secondary" size="sm" onClick={() => void (manual ? deletions.confirmLegacyDeletion(operation) : deletions.retryDeletion(operation))}>
            {manual ? text('确认人工核对并继续', 'Confirm and continue') : text('重试清理', 'Retry cleanup')}
          </Button>
        )}
      >
        {[operation.manuscriptStatus === 'failed' ? operation.manuscriptError : '', operation.knowledgeStatus === 'failed' ? operation.knowledgeError : ''].filter(Boolean).join('；') || null}
      </Notice>
    )
  })
}
