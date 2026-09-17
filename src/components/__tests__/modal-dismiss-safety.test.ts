/**
 * 弹窗防误触契约。
 *
 * 先生（作者反馈）：AI 生成完伏笔 / 蓝图 / 设定候选后弹出来的面板，切屏出去干点别的
 * 再切回来，手一抖点到蒙版就把窗口关了 —— 等了几分钟才有的候选当场作废；而作者常常
 * 正需要离开去补设定，才能判断该不该选。
 *
 * 因此约定：**凡装「AI 生成结果」或「填到一半的参数」的弹窗，点蒙版不算关闭**，
 * 只有面板内的明确按钮才算。这条约束截图看不出来，用源码断言守住。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PROTECTED_DIALOGS = [
  // AI 生成结果：候选 / 事件 / 冲突 / 审稿确认，误关等于白等一轮
  'src/components/editor/WorldSettingCandidateDialog.tsx',
  'src/components/editor/NarrativeThreadEditor.tsx',
  'src/components/editor/WorldSettingConflictDialog.tsx',
  'src/components/editor/ReviewReport.tsx',
  'src/components/characters/CharacterCardCandidateDialog.tsx',
  // 填到一半的参数或输入：误关就得重来
  'src/components/dialogs/ArchitectureConfirmDialog.tsx',
  'src/components/dialogs/DirectoryConfigDialog.tsx',
  'src/components/dialogs/BatchChapterCreationDialog.tsx',
  'src/components/dialogs/ChapterCreationDialog.tsx',
  'src/components/dialogs/GenerateConfigDialog.tsx',
  'src/components/dialogs/ImportNovelDialog.tsx',
  'src/components/dialogs/NewProjectDialog.tsx',
  'src/components/dialogs/ExportDialog.tsx',
  'src/components/characters/CharacterCardImportButton.tsx',
  'src/components/editor/WorldSettingChapterRefDialog.tsx',
  'src/components/panels/sidebar/WorldSettingSidebarPanel.tsx',
] as const

describe('弹窗防误触契约', () => {
  it.each(PROTECTED_DIALOGS)('%s 拒绝点击蒙版关闭', (file) => {
    const source = readFileSync(file, 'utf8')
    /**
     * 两种写法都算数：
     *   · onPointerDownOutside 是常规做法；
     *   · GenerateConfigDialog 还要连带覆盖「全局 Confirm 渲染在 body 上、被 Radix
     *     误判成外部点击」的场景，用的是它的父事件 onInteractOutside。
     */
    const blocksPointerDismiss =
      source.includes('onPointerDownOutside={(event) => event.preventDefault()}')
      || source.includes('onInteractOutside={e => e.preventDefault()}')
    expect(blocksPointerDismiss).toBe(true)
  })
})
