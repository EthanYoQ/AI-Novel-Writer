/**
 * 创作资料角色候选的提交 seam（渲染层）。
 *
 * 为什么把提交从工作流里搬出来：旧实现把它写成工作流的第二步，于是「确认」
 * 被降级成任务面板里的一个「继续」按钮 —— 作者既看不到候选内容，也没有勾选
 * 的机会；一旦没留意那个等待状态，第二步永不执行，界面却仍报「角色卡已导入
 * 角色名单」。
 *
 * 现在的分工是：
 *   · 工作流只负责**提取**（ExtractPlanningMaterialCharactersCommand）；
 *   · 提取结果交给 CharacterCardCandidateDialog 让作者逐条过目；
 *   · 作者确认后由本模块提交。
 *
 * 健壮性要点（每一条都对应一个真实的失败面，不是装饰）：
 *   1. 提交前**重新读取** revision，绝不复用面板打开那一刻的旧版本 —— 面板可能
 *      开了很久，期间定稿后处理等流程完全可能推进过名单；缓存旧值必然误伤。
 *   2. operationId 由调用方按「提取批次 + 本次勾选」派生：同一次提交重试保持
 *      幂等（仓库层按 payload_hash 去重），改了勾选就是另一次提交（复用同一 ID
 *      会被仓库层以「操作 ID 已被用于不同的角色名单」拒绝）。
 *   3. read 与 commit 之间仍有极小竞态：仓库层以 expected_revision 拒绝过期写入，
 *      这里把那种拒绝翻译成**可重试**的明确出路，而不是把原始错误抛给作者。
 *   4. 提交前再校验一次项目会话：项目已切换就明确告知，绝不静默写入、也绝不静默丢弃。
 *   5. 只有真正写入成功才广播刷新；失败路径不污染 UI 缓存。
 */
import type {
  CharacterRosterCommitRequest,
  CharacterRosterEntry,
  CharacterRosterSnapshot,
} from '../shared/character-roster'
import { CHARACTER_ROSTER_SCHEMA_VERSION, characterRosterIdentityKey } from '../shared/character-roster'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { globalEventBus } from '../shared/event-bus'
import { splitRelationshipEditorValue } from '../shared/relationship-presentation'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../shared/project-session-context'
import { useProjectStore } from '../stores/project-store'
import { ipc } from './ipc-client'

/** 仿写/资料导入语义：仓库层据此走**保守合并**，不会覆盖作者已有的手工字段。 */
export const PLANNING_MATERIAL_CHARACTER_COMMIT_INTENT = 'novel_import' as const

export type PlanningMaterialCharacterCommitResult =
  | { success: true; savedCount: number; idempotent: boolean }
  | { success: false; error: string; retryable: boolean }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sessionStillCurrent(session: ProjectSessionContext): boolean {
  return sameProjectSessionContext(
    session,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

/**
 * 把关系备注里「目标其实已经在最终名单里」的行提升成结构化关系边。
 *
 * 提取候选时只认得本批卡名，与项目现有角色之间的关系因此被留成了备注；
 * 到了提交这一步最终名单已知，能确定的关系就应该真的成边（图谱能画、
 * 写稿注入能用上），而不是永远停在备注里。
 */
function promoteKnownRelationshipTargets(
  entries: readonly CharacterRosterEntry[],
  finalNames: ReadonlySet<string>,
): CharacterRosterEntry[] {
  const knownNames = [...finalNames]
  return entries.map((entry) => {
    const notes = entry.relationshipNotes?.trim()
    if (!notes) return { ...entry }
    const split = splitRelationshipEditorValue(notes, {
      knownNames,
      selfName: entry.name,
    })
    if (split.edges.length === 0) return { ...entry }
    const relationships = [...entry.relationships]
    for (const edge of split.edges) {
      if (!relationships.some(existing => (
        existing.target === edge.target && existing.relation === edge.relation
      ))) {
        relationships.push(edge)
      }
    }
    const remainingNotes = split.notes.trim()
    const promoted: CharacterRosterEntry = { ...entry, relationships }
    if (remainingNotes) promoted.relationshipNotes = remainingNotes
    else delete promoted.relationshipNotes
    return promoted
  })
}

/**
 * 把指向「本次不会进名单的角色」的关系边降级为关系备注。
 *
 * 勾选是作者的取舍：被舍掉的候选人不会落盘，指向它的边无法成立。与其让整批
 * 提交被闭包校验拒绝，不如把边还原成作者原话留作备注——信息不丢，名单自洽。
 */
function detachDanglingRelationships(
  entries: readonly CharacterRosterEntry[],
  finalNames: ReadonlySet<string>,
): CharacterRosterEntry[] {
  return entries.map((entry) => {
    const kept: CharacterRosterEntry['relationships'] = []
    const dropped: string[] = []
    for (const edge of entry.relationships) {
      if (finalNames.has(characterRosterIdentityKey(edge.target))) kept.push(edge)
      else dropped.push(`${edge.target}：${edge.relation}`)
    }
    if (dropped.length === 0) return { ...entry }
    const relationshipNotes = [...dropped, entry.relationshipNotes?.trim() ?? '']
      .filter(Boolean)
      .join('\n')
    return {
      ...entry,
      relationships: kept,
      ...(relationshipNotes ? { relationshipNotes } : {}),
    }
  })
}

/**
 * 仓库层的拒绝分两类，出路完全不同：
 *   · 乐观锁过期 / 暂态失败 = 再点一次就能成（可重试）；
 *   · 提交标识冲突 / 名单状态不安全 = 重试也没用，必须换动作（不可重试）。
 * 把原始异常直接抛给作者，等于让他对着「revision 已过期」自己猜。
 */
function translateCommitFailure(message: string): { error: string; retryable: boolean } {
  if (message.includes('revision 已过期')) {
    return {
      error: '角色名单在预览期间被其它流程改动过。请核对候选后再次点击「写入」，本次会按最新名单重新提交。',
      retryable: true,
    }
  }
  if (message.includes('操作 ID 已被用于不同的')) {
    return {
      error: '本次提交的内容与上一次不一致（提交标识冲突）。请关闭面板后重新提取一次。',
      retryable: false,
    }
  }
  if (message.includes('旧角色图谱') || message.includes('状态不一致')) {
    return {
      error: '项目里的角色数据需要先按提示修复，之后才能导入角色卡。',
      retryable: false,
    }
  }
  return { error: message || '角色卡未能保存，请重试。', retryable: true }
}

export async function commitPlanningMaterialCharacters(params: {
  session: ProjectSessionContext
  entries: readonly CharacterRosterEntry[]
  /** 由调用方按「提取批次 + 勾选内容」派生，保证同一次提交的重试幂等。 */
  operationId: string
  /**
   * 作者已对同名角色做出选择（直接覆盖、或在合并窗口里逐项确认过）：
   * 本次同名条目以候选内容为准。
   */
  overwriteExisting?: boolean
}): Promise<PlanningMaterialCharacterCommitResult> {
  const { session, entries, operationId, overwriteExisting = false } = params

  if (entries.length === 0) {
    return { success: false, error: '没有勾选任何角色卡，角色名单未改动。', retryable: false }
  }
  if (!sessionStillCurrent(session)) {
    return { success: false, error: '当前项目已切换或会话失效，本次角色卡未写入。', retryable: false }
  }

  let roster: CharacterRosterSnapshot | null = null
  try {
    roster = await ipc.invokeWithProjectSession(
      session,
      'db:character-roster-read',
      session.projectPath,
    )
  } catch (error) {
    return { success: false, error: `读取角色名单失败：${errorMessage(error)}`, retryable: true }
  }
  if (!roster) {
    return { success: false, error: '未能读取当前角色名单，请先打开项目后重试。', retryable: true }
  }
  if (roster.status !== 'ready' && roster.status !== 'empty') {
    return {
      success: false,
      error: '角色名单当前不可安全导入（可能缺少角色卡或状态不一致），请先按项目提示修复旧角色数据。',
      retryable: false,
    }
  }

  // 读取之后作者仍可能切项目；写入前必须再确认一次会话身份。
  if (!sessionStillCurrent(session)) {
    return { success: false, error: '当前项目已切换或会话失效，本次角色卡未写入。', retryable: false }
  }

  // 作者可能只勾选了部分候选：未勾选的角色不进名单，指向它的关系边在主进程
  // 的闭包校验里就是悬空边。这里把悬空边降级成关系备注——作者的原话一字不丢，
  // 整批提交也不会因为「只勾了一部分」而失败。
  const finalNames = new Set([
    ...roster.entries.map(entry => characterRosterIdentityKey(entry.name)),
    ...entries.map(entry => characterRosterIdentityKey(entry.name)),
  ])
  const committedEntries = detachDanglingRelationships(
    promoteKnownRelationshipTargets(entries, finalNames),
    finalNames,
  )

  try {
    const result = await ipc.invokeWithProjectSession(
      session,
      'db:character-roster-commit',
      {
        operationId,
        // 提交前的这份快照才是乐观锁依据，不是面板打开时的那份。
        expectedRevision: roster.revision,
        schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION,
        entries: committedEntries,
        intent: PLANNING_MATERIAL_CHARACTER_COMMIT_INTENT,
        ...(overwriteExisting ? { overwriteExisting: true } : {}),
      } satisfies CharacterRosterCommitRequest,
      session.projectPath,
    )
    if (!result.success) {
      return { success: false, ...translateCommitFailure(result.error ?? '') }
    }
    globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['characterCards'],
      projectPath: session.projectPath,
      projectSession: session,
    })
    return {
      success: true,
      savedCount: entries.length,
      idempotent: Boolean(result.receipt?.idempotent),
    }
  } catch (error) {
    return { success: false, ...translateCommitFailure(errorMessage(error)) }
  }
}
