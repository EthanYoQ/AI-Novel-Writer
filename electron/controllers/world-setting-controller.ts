/**
 * WorldSettingController — 世界观设定条目的 IPC 入口
 *
 * 形态对齐 character-avatar-controller：渲染层只说「读 / 存 / 删哪一条」，
 * 库表与 JSON 列的细节全部留在主进程。
 *
 * 项目一致性闸门：渲染层传来的 expectedProjectPath 必须就是当前打开的项目，
 * 否则一律拒绝 —— 避免切换作品的一瞬间把 A 作品的设定写进 B 作品。
 */
import { app, ipcMain } from 'electron'

import type { AppErrorCode, AppFailure } from '../../src/shared/ipc-channels'
import { normalizeWorldSettingStatus } from '../../src/shared/world-setting'
import type { WorldSettingDraft, WorldSettingConflictDraft } from '../../src/shared/world-setting'
import { getCurrentProjectPath } from '../database'
import { mainText } from '../i18n'
import { WorldSettingRepository } from '../repositories/world-setting-repository'
import { WorldSettingCategoryRepository } from '../repositories/world-setting-category-repository'
import type { WorldSettingCategoryDraft } from '../../src/shared/world-setting'

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

/**
 * 定稿后追加单条进展的长度上限。
 * 与提示词注入闸门同一量级：单条进展只是一句「第 N 章发生了什么」，
 * 不该比整段注入还长 —— 超长说明模型跑偏了，宁可拒绝也不要写进事实源。
 */
const MAX_APPENDED_UPDATE_CHARS = 1200

function failure(errorCode: AppErrorCode, message: string): AppFailure {
  return { success: false, errorCode, error: message }
}

/** 返回非 null 表示应当直接回绝本次请求。 */
function guardProject(expectedProjectPath: unknown): AppFailure | null {
  const current = getCurrentProjectPath()
  if (!current) return failure('PROJECT_NOT_OPEN', text('尚未打开项目。', 'No project is open.'))
  if (typeof expectedProjectPath !== 'string' || expectedProjectPath !== current) {
    return failure('PROJECT_NOT_OPEN', text('当前项目已切换，请重试。', 'The project changed. Please try again.'))
  }
  return null
}

export function registerWorldSettingController(): void {
  ipcMain.handle('world-setting:list', (_event, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    try {
      return WorldSettingRepository.getAll()
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`读取世界观设定失败：${String(error)}`, `Could not read world settings: ${String(error)}`),
      )
    }
  })

  ipcMain.handle('world-setting:save', (_event, draft: unknown, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    if (!draft || typeof draft !== 'object') {
      return failure('DATABASE_ERROR', text('条目内容无效，未保存。', 'The entry is invalid and was not saved.'))
    }
    const name = typeof (draft as WorldSettingDraft).name === 'string' ? (draft as WorldSettingDraft).name.trim() : ''
    if (!name) {
      return failure('DATABASE_ERROR', text('条目名不能为空。', 'The entry name cannot be empty.'))
    }
    try {
      const saved = WorldSettingRepository.save(draft as WorldSettingDraft)
      if (!saved) {
        return failure(
          'DATABASE_ERROR',
          text('条目名无效（过长或含控制字符），未保存。', 'The entry name is invalid (too long or contains control characters), so it was not saved.'),
        )
      }
      return saved
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`保存世界观设定失败：${String(error)}`, `Could not save the world setting: ${String(error)}`),
      )
    }
  })

  ipcMain.handle('world-setting:delete', (_event, id: unknown, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      return failure('DATABASE_ERROR', text('条目 id 无效。', 'The entry id is invalid.'))
    }
    try {
      return { deleted: WorldSettingRepository.delete(id) }
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`删除世界观设定失败：${String(error)}`, `Could not delete the world setting: ${String(error)}`),
      )
    }
  })

  /**
   * 采纳 / 退回。作者点「采纳」才把候选变成事实源（此后才参与生成注入）；
   * 点「忽略」走 delete —— AI 猜错的东西没必要留在库里。
   */
  ipcMain.handle('world-setting:set-status', (_event, id: unknown, status: unknown, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      return failure('DATABASE_ERROR', text('条目 id 无效。', 'The entry id is invalid.'))
    }
    try {
      const updated = WorldSettingRepository.setStatus(id, normalizeWorldSettingStatus(status))
      if (!updated) {
        return failure('DATABASE_ERROR', text('该条目已不存在，状态未修改。', 'That entry no longer exists; its status was not changed.'))
      }
      return updated
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`修改世界观设定状态失败：${String(error)}`, `Could not update the world setting status: ${String(error)}`),
      )
    }
  })

  // ===== 分类表 =====
  // 分类允许作者自建，所以一切都走库表；条目只存 key，改名不影响条目。

  ipcMain.handle('world-setting:list-categories', (_event, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    try {
      return WorldSettingCategoryRepository.list()
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`读取设定分类失败：${String(error)}`, `Could not read setting categories: ${String(error)}`),
      )
    }
  })

  ipcMain.handle('world-setting:create-category', (_event, draft: unknown, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    if (!draft || typeof draft !== 'object') {
      return failure('DATABASE_ERROR', text('分类内容无效，未创建。', 'The category is invalid and was not created.'))
    }
    try {
      const created = WorldSettingCategoryRepository.create(draft as WorldSettingCategoryDraft)
      if (!created) {
        return failure('DATABASE_ERROR', text('分类名不能为空，且不要超过 40 个字。', 'A category name is required and must stay under 40 characters.'))
      }
      return created
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`新建设定分类失败：${String(error)}`, `Could not create the setting category: ${String(error)}`),
      )
    }
  })

  ipcMain.handle('world-setting:update-category', (_event, key: unknown, draft: unknown, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    if (typeof key !== 'string' || !key) {
      return failure('DATABASE_ERROR', text('分类标识无效。', 'The category key is invalid.'))
    }
    try {
      const updated = WorldSettingCategoryRepository.update(key, (draft ?? {}) as WorldSettingCategoryDraft)
      if (!updated) {
        return failure('DATABASE_ERROR', text('该分类已不存在，未修改。', 'That category no longer exists; nothing was changed.'))
      }
      return updated
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`修改设定分类失败：${String(error)}`, `Could not update the setting category: ${String(error)}`),
      )
    }
  })

  ipcMain.handle('world-setting:remove-category', (_event, key: unknown, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    if (typeof key !== 'string' || !key) {
      return failure('DATABASE_ERROR', text('分类标识无效。', 'The category key is invalid.'))
    }
    try {
      // 删不掉的两种情形由界面翻译成人话（内置 / 里面还有条目），这里只回原因。
      return WorldSettingCategoryRepository.remove(key)
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`删除设定分类失败：${String(error)}`, `Could not delete the setting category: ${String(error)}`),
      )
    }
  })

  // ===== 章节引用 =====
  // 先生定的路线：写某一章时只注入这里指明的设定，绝不按章全量加载。

  ipcMain.handle('world-setting:list-chapter-refs', (_event, chapterNumber: unknown, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    if (typeof chapterNumber !== 'number' || !Number.isInteger(chapterNumber)) {
      return failure('DATABASE_ERROR', text('章节号无效。', 'The chapter number is invalid.'))
    }
    try {
      return WorldSettingRepository.listChapterRefs(chapterNumber)
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`读取章节引用失败：${String(error)}`, `Could not read chapter references: ${String(error)}`),
      )
    }
  })

  ipcMain.handle(
    'world-setting:add-chapter-ref',
    (_event, chapterNumber: unknown, settingId: unknown, source: unknown, expectedProjectPath: unknown) => {
      const denied = guardProject(expectedProjectPath)
      if (denied) return denied
      if (typeof chapterNumber !== 'number' || !Number.isInteger(chapterNumber)
        || typeof settingId !== 'number' || !Number.isInteger(settingId)) {
        return failure('DATABASE_ERROR', text('章节号或条目无效。', 'The chapter number or entry is invalid.'))
      }
      try {
        const ok = WorldSettingRepository.addChapterRef(
          chapterNumber,
          settingId,
          source === 'ai' ? 'ai' : 'manual',
        )
        if (!ok) {
          return failure('DATABASE_ERROR', text('该条目已不存在，引用未添加。', 'That entry no longer exists, so the reference was not added.'))
        }
        return { ok: true }
      } catch (error) {
        return failure(
          'DATABASE_ERROR',
          text(`添加章节引用失败：${String(error)}`, `Could not add the chapter reference: ${String(error)}`),
        )
      }
    },
  )

  ipcMain.handle(
    'world-setting:remove-chapter-ref',
    (_event, chapterNumber: unknown, settingId: unknown, expectedProjectPath: unknown) => {
      const denied = guardProject(expectedProjectPath)
      if (denied) return denied
      if (typeof chapterNumber !== 'number' || !Number.isInteger(chapterNumber)
        || typeof settingId !== 'number' || !Number.isInteger(settingId)) {
        return failure('DATABASE_ERROR', text('章节号或条目无效。', 'The chapter number or entry is invalid.'))
      }
      try {
        return { removed: WorldSettingRepository.removeChapterRef(chapterNumber, settingId) }
      } catch (error) {
        return failure(
          'DATABASE_ERROR',
          text(`移除章节引用失败：${String(error)}`, `Could not remove the chapter reference: ${String(error)}`),
        )
      }
    },
  )

  /**
   * 定稿后处理：把本章的进展追加到条目上（只增不改）。
   *
   * 这个通道是「让世界观设定能落袋」的那一环 —— 没有它，
   * 正文一直往前写、设定库却停在建库那一刻，AI 拿到的"事实源"会越来越过时。
   */
  ipcMain.handle(
    'world-setting:append-derived',
    (
      _event,
      id: unknown,
      update: unknown,
      chapterNumber: unknown,
      expectedProjectPath: unknown,
    ) => {
      const denied = guardProject(expectedProjectPath)
      if (denied) return denied
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        return failure('DATABASE_ERROR', text('条目无效。', 'The entry is invalid.'))
      }
      if (typeof chapterNumber !== 'number' || !Number.isInteger(chapterNumber) || chapterNumber <= 0) {
        return failure('DATABASE_ERROR', text('章节号无效。', 'The chapter number is invalid.'))
      }
      const record = (update && typeof update === 'object' && !Array.isArray(update))
        ? update as { content?: unknown; summary?: unknown }
        : {}
      const content = typeof record.content === 'string' ? record.content : ''
      const summary = typeof record.summary === 'string' ? record.summary : ''
      // 上限定在注入闸门同一量级：单条追加不该比整段注入还长。
      if (content.length > MAX_APPENDED_UPDATE_CHARS || summary.length > MAX_APPENDED_UPDATE_CHARS) {
        return failure(
          'DATABASE_ERROR',
          text('追加内容过长，已拒绝写入。', 'The appended update is too long and was rejected.'),
        )
      }
      try {
        const result = WorldSettingRepository.appendDerived(id, { content, summary }, chapterNumber)
        if (!result) {
          return failure('DATABASE_ERROR', text('条目不存在。', 'The entry does not exist.'))
        }
        return result
      } catch (error) {
        return failure(
          'DATABASE_ERROR',
          text(`追加设定进展失败：${String(error)}`, `Could not append the setting update: ${String(error)}`),
        )
      }
    },
  )

  // ===== 冲突裁决队列 =====

  ipcMain.handle('world-setting:list-conflicts', (_event, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    try {
      return WorldSettingRepository.listOpenConflicts()
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`读取设定冲突失败：${String(error)}`, `Could not read setting conflicts: ${String(error)}`),
      )
    }
  })

  ipcMain.handle('world-setting:record-conflict', (_event, draft: unknown, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      return failure('DATABASE_ERROR', text('冲突记录无效。', 'The conflict record is invalid.'))
    }
    try {
      const conflict = WorldSettingRepository.createConflict(draft as WorldSettingConflictDraft)
      if (!conflict) {
        return failure('DATABASE_ERROR', text('冲突记录不完整。', 'The conflict record is incomplete.'))
      }
      return conflict
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`登记设定冲突失败：${String(error)}`, `Could not record the setting conflict: ${String(error)}`),
      )
    }
  })

  ipcMain.handle(
    'world-setting:resolve-conflict',
    (_event, id: unknown, resolution: unknown, expectedProjectPath: unknown) => {
      const denied = guardProject(expectedProjectPath)
      if (denied) return denied
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        return failure('DATABASE_ERROR', text('冲突记录无效。', 'The conflict record is invalid.'))
      }
      if (resolution !== 'adopted-draft' && resolution !== 'kept-entry') {
        return failure('DATABASE_ERROR', text('裁决方式无效。', 'The resolution is invalid.'))
      }
      try {
        const result = WorldSettingRepository.resolveConflict(id, resolution)
        if (!result) {
          return failure('DATABASE_ERROR', text('冲突记录不存在。', 'The conflict record does not exist.'))
        }
        return { resolved: true, entry: result.entry }
      } catch (error) {
        return failure(
          'DATABASE_ERROR',
          text(`裁决设定冲突失败：${String(error)}`, `Could not resolve the setting conflict: ${String(error)}`),
        )
      }
    },
  )

  ipcMain.handle('world-setting:ignore-conflict', (_event, id: unknown, expectedProjectPath: unknown) => {
    const denied = guardProject(expectedProjectPath)
    if (denied) return denied
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      return failure('DATABASE_ERROR', text('冲突记录无效。', 'The conflict record is invalid.'))
    }
    try {
      return { ignored: Boolean(WorldSettingRepository.ignoreConflict(id)) }
    } catch (error) {
      return failure(
        'DATABASE_ERROR',
        text(`忽略设定冲突失败：${String(error)}`, `Could not ignore the setting conflict: ${String(error)}`),
      )
    }
  })

  /**
   * 批量裁决（先生要的「一条条看很烦」的出口）。
   * 仓储侧用事务包住，避免中途失败留下「一半采纳了」的难收拾状态。
   */
  ipcMain.handle(
    'world-setting:resolve-all-conflicts',
    (_event, resolution: unknown, expectedProjectPath: unknown) => {
      const denied = guardProject(expectedProjectPath)
      if (denied) return denied
      if (resolution !== 'adopted-draft' && resolution !== 'kept-entry') {
        return failure('DATABASE_ERROR', text('裁决方式无效。', 'The resolution is invalid.'))
      }
      try {
        return WorldSettingRepository.resolveAllConflicts(resolution)
      } catch (error) {
        return failure(
          'DATABASE_ERROR',
          text(`批量裁决设定冲突失败：${String(error)}`, `Could not resolve the setting conflicts: ${String(error)}`),
        )
      }
    },
  )
}
