import { discardAllEditorChanges } from '../../stores/editor-discard'

/**
 * 更新安装前先同步放弃编辑状态。
 *
 * 即使安装请求失败或应用没有退出，放弃操作也已经完成，不会重新出现伪 dirty 状态。
 */
export async function discardChangesThenRequestInstall(
  requestInstall: () => Promise<void>,
): Promise<void> {
  discardAllEditorChanges()
  await requestInstall()
}
