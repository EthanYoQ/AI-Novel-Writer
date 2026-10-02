/**
 * WorldSettingConflictDialog — 「正文 vs 设定」冲突裁决
 *
 * 先生的原话：「这样用户不用自己苦哈哈的去寻找修改了。」
 *
 * 定稿后 AI 能发现「正文与某条设定直接矛盾」，但它**不知道该听哪边** ——
 * 条目写「青云宗已覆灭」、正文写「青云宗派人来援」，自动改等于赌。
 * 所以这里给作者三个出口，每条冲突都能一键处理：
 *
 *   · 采纳正文 —— 把正文这条已确认事实**追加**进条目（仍然只增不改；
 *     作者原文一个字都不动，新事实以「（第 N 章：…）」补在后面）
 *   · 保留条目 —— 认定原设定才对，只标记已解决，不动任何内容
 *   · 稍后 —— 不是真冲突，或暂时不想处理
 *
 * 每行并排展示「正文说了什么」与「条目原来写什么」——
 * 这正是作者做判断需要的全部信息，不必再回设定库翻找。
 */
import { AlertTriangle } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/Dialog'
import { confirm } from '../ui/Confirm'
import { useLocaleStore } from '../../stores/locale-store'
import type { WorldSettingConflict } from '../../shared/world-setting'

interface Props {
  open: boolean
  conflicts: WorldSettingConflict[]
  busy: boolean
  onClose: () => void
  /**
   * 裁决：传 ids 表示只处理这几条；**不传**表示处理全部未决
   * （先生要的「一条条看很烦」的出口）。
   */
  onResolve: (ids: number[] | undefined, resolution: 'adopted-draft' | 'kept-entry') => void
  onIgnore: (id: number) => void
}

export default function WorldSettingConflictDialog({
  open,
  conflicts,
  busy,
  onClose,
  onResolve,
  onIgnore,
}: Props) {
  const text = useLocaleStore(s => s.text)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        className="max-w-[640px]"
        /* 先生：裁决常要离开去翻设定才能定，误点蒙版关掉就得再等一轮 AI。 */
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{text('设定冲突裁决', 'Setting conflicts')}</DialogTitle>
          <DialogDescription>
            {text(
              '正文与设定打架时，AI 只负责发现、不替你改 —— 因为它不知道哪边才是你要的。逐条裁决即可，采纳正文不会覆盖条目原文，只会在后面追加一条带章号的进展。',
              'When the draft and a setting disagree, the AI only reports it — it cannot know which side you want. Resolve each one below; adopting the draft appends a chapter-tagged development rather than overwriting your original text.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 max-h-[56vh] overflow-y-auto py-1">
          {conflicts.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {text('没有待裁决的冲突。', 'No conflicts waiting for your call.')}
            </p>
          )}
          {conflicts.map((conflict) => (
            <div className="ws-conflict-row" key={conflict.id}>
              <div className="ws-conflict-head">
                <AlertTriangle size={12} aria-hidden="true" />
                <span className="ws-conflict-name">{conflict.settingName}</span>
                <span className="ws-conflict-chapter">
                  {text(`第 ${conflict.chapterNumber} 章`, `Chapter ${conflict.chapterNumber}`)}
                </span>
              </div>

              {conflict.statement && (
                <div className="ws-conflict-claim">{conflict.statement}</div>
              )}

              <div className="ws-conflict-pair">
                <div className="ws-conflict-side">
                  <span className="ws-conflict-label">{text('本条正文', 'This draft')}</span>
                  <span className="ws-conflict-quote">{conflict.evidence}</span>
                </div>
                <div className="ws-conflict-side">
                  <span className="ws-conflict-label">{text('设定原文', 'Current entry')}</span>
                  <span className="ws-conflict-quote">
                    {conflict.settingContentSnapshot || text('（条目正文为空）', '(entry text is empty)')}
                  </span>
                </div>
              </div>

              <div className="ws-conflict-actions">
                <button
                  className="btn primary sm"
                  type="button"
                  disabled={busy}
                  onClick={() => onResolve([conflict.id], 'adopted-draft')}
                >
                  {text('采纳正文', 'Adopt draft')}
                </button>
                <button
                  className="btn outline sm"
                  type="button"
                  disabled={busy}
                  onClick={() => onResolve([conflict.id], 'kept-entry')}
                >
                  {text('保留条目', 'Keep entry')}
                </button>
                <button
                  className="btn ghost sm"
                  type="button"
                  disabled={busy}
                  onClick={() => onIgnore(conflict.id)}
                >
                  {text('稍后', 'Later')}
                </button>
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <button className="btn ghost sm" type="button" onClick={onClose} disabled={busy}>
            {text('关闭', 'Close')}
          </button>
          {/* 批量出口：先生要的「有些用户觉得一条条看很烦」。
              两个都带二次确认 —— 它们会一次清空整个队列，
              误点的代价比逐条点错大得多。 */}
          {conflicts.length > 1 && (
            <>
              <button
                className="btn outline sm"
                type="button"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    const ok = await confirm(
                      text(
                        `将把 ${conflicts.length} 条冲突全部标记为已解决，设定内容不会改动。`,
                        `All ${conflicts.length} conflicts will be marked resolved. No entry content is changed.`,
                      ),
                      {
                        title: text('保留全部条目原文？', 'Keep every entry as-is?'),
                        confirmText: text('保留全部', 'Keep all'),
                      },
                    )
                    if (ok) onResolve(undefined, 'kept-entry')
                  })()
                }}
              >
                {text(`全部保留（${conflicts.length}）`, `Keep all (${conflicts.length})`)}
              </button>
              <button
                className="btn primary sm"
                type="button"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    const ok = await confirm(
                      text(
                        `将把 ${conflicts.length} 条正文事实分别追加到对应条目（原文不覆盖，只补一行带章号的进展）。`,
                        `All ${conflicts.length} draft facts will be appended to their entries. Original text is never overwritten — only a chapter-tagged line is added.`,
                      ),
                      {
                        title: text('采纳全部正文？', 'Adopt every draft?'),
                        confirmText: text('全部采纳', 'Adopt all'),
                        danger: true,
                      },
                    )
                    if (ok) onResolve(undefined, 'adopted-draft')
                  })()
                }}
              >
                {text(`全部采纳（${conflicts.length}）`, `Adopt all (${conflicts.length})`)}
              </button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
