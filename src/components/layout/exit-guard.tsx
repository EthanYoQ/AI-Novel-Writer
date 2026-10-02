/**
 * exit-guard —— 退出确认对话框（组件模块）
 *
 * 退出语义（useExitGuard + ExitRequest / ExitGuard 类型）已拆到
 * ./use-exit-guard：本文件只留组件，react-refresh 才能做组件级热替换。
 *
 * 版式（先生定调）：
 *   · 标头与各子菜单页头同源 —— 朱砂小字眉标 → 衬线标题 → 次要色说明
 *     （PageHead + .app-dialog-head，见 v2-dialog.css）；
 *   · 中间说清楚**哪部作品、哪个地方**没保存，每条都带「前往此处」跳过去确认；
 *   · 底部只留两个出口：左侧「放弃并退出」占原来「取消」的位置、沿用它的
 *     outline 样式，右侧「保存并退出」保持主按钮 —— 两个出口一眼能分出轻重。
 *     「取消退出」不再单设按钮：右上角的 X（与 Esc、点蒙版）就是它。
 */
import { AlertTriangle, ArrowUpRight } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import PageHead from '../ui/PageHead'
import type { ExitGuard } from './use-exit-guard'
import { groupUnsavedEditorItems } from './unsaved-editor-targets'

// 类型回传：使用方仍可从 './exit-guard' 取到这两个类型（类型导出不产生运行时值，
// 不影响本文件的「只导出组件」判定）。
export type { ExitGuard, ExitRequest } from './use-exit-guard'

/** 退出确认对话框。两套顶栏共用，文案与按钮语义完全一致。 */
export function ExitGuardDialog({ guard }: { guard: ExitGuard }) {
  const {
    exitRequest, exitBusy, exitError, unsavedItems,
    cancelExit, discardAndExit, saveAndExit, revealUnsavedItem,
  } = guard
  const text = useLocaleStore((s) => s.text)
  const recentProjects = useProjectStore((s) => s.recentProjects)
  const currentProjectPath = useProjectStore((s) => s.currentProject?.path)

  const blocked = exitRequest?.workflowBlocked === true
  const groups = blocked
    ? []
    : groupUnsavedEditorItems(unsavedItems, { recentProjects, currentProjectPath, text })
  const otherProjectGroups = groups.filter(group => group.projectKey && !group.isCurrentProject)
  const entryCount = groups.reduce((total, group) => total + group.entries.length, 0)

  const description = blocked
    ? text(
        '请先等待当前创作任务完成，或在任务面板中取消任务后再退出。',
        'Wait for the current creative task to finish, or cancel it in the task panel before exiting.',
      )
    : entryCount === 0
      ? text(
          '保存会使用每个编辑器现有的项目会话；无法安全保存或保存期间又有输入时，应用不会退出。',
          'Each editor saves through its existing project session. The app stays open if a save is unsafe or new input arrives while saving.',
        )
      : otherProjectGroups.length > 0
        ? text(
            '当前作品之外还有其他作品留有未保存内容，退出时无法替它们保存 —— 请点「前往此处」跳过去确认。',
            'Other works still hold unsaved edits that cannot be saved on exit. Use "Go there" to check them first.',
          )
        : text(
            '这些内容还没有写入磁盘。「保存并退出」会逐一保存后关闭窗口，也可以先去确认一下。',
            'These edits are not on disk yet. "Save and exit" writes them all, then closes the window.',
          )

  return (
    <Dialog open={exitRequest !== null} onOpenChange={(open) => {
      if (!open) void cancelExit()
    }}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader className="app-dialog-head">
          <DialogTitle className="sr-only">{blocked
            ? text('创作任务仍在运行', 'Creative task still running')
            : text('退出前处理未保存内容', 'Handle unsaved changes before exiting')}</DialogTitle>
          <PageHead
            kicker={blocked
              ? text('EXIT · 退出受阻', 'EXIT · BLOCKED')
              : text('EXIT · 退出确认', 'EXIT · CONFIRM')}
            title={blocked
              ? text('创作任务仍在运行', 'Creative task still running')
              : text('退出前处理未保存内容', 'Handle unsaved changes before exiting')}
            description={description}
          />
        </DialogHeader>

        {groups.length > 0 && (
          <div className="exit-unsaved">
            {groups.map(group => (
              <section className="exit-unsaved-group" key={group.projectKey ?? 'unattributable'}>
                <div className="exit-unsaved-head">
                  <span className="exit-unsaved-project">{group.projectName}</span>
                  <span className={group.isCurrentProject
                    ? 'exit-unsaved-tag exit-unsaved-tag-here'
                    : 'exit-unsaved-tag exit-unsaved-tag-away'}
                  >
                    {group.isCurrentProject
                      ? text('当前作品', 'Current work')
                      : text('另一部作品', 'Another work')}
                  </span>
                </div>
                {group.projectPath && <div className="exit-unsaved-path">{group.projectPath}</div>}
                <ul className="exit-unsaved-list">
                  {group.entries.map(entry => (
                    <li className="exit-unsaved-item" key={entry.item.key}>
                      <span className="exit-unsaved-editor">{entry.editorLabel}</span>
                      {entry.entryLabel && (
                        <span className="exit-unsaved-name">{entry.entryLabel}</span>
                      )}
                      {entry.item.projectKey && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="exit-unsaved-jump"
                          disabled={exitBusy}
                          onClick={() => void revealUnsavedItem(entry.item)}
                        >
                          {text('前往此处', 'Go there')}
                          <ArrowUpRight size={12} />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {exitError && (
          <div className="exit-unsaved-alert" role="alert">
            <AlertTriangle size={13} />
            <span>{exitError}</span>
          </div>
        )}

        <DialogFooter className={blocked ? 'justify-end' : undefined}>
          {blocked ? (
            <Button variant="outline" onClick={() => void cancelExit()} disabled={exitBusy}>
              {text('知道了', 'OK')}
            </Button>
          ) : (
            <>
              {/* 位置与样式都沿用原「取消」按钮：放弃是不可挽回的一侧，不应更醒目。 */}
              <Button variant="outline" onClick={() => void discardAndExit()} disabled={exitBusy}>
                {text('放弃并退出', 'Discard and exit')}
              </Button>
              <Button onClick={() => void saveAndExit()} disabled={exitBusy}>
                {exitBusy ? text('处理中...', 'Working...') : text('保存并退出', 'Save and exit')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
