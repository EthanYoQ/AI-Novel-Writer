import { workflowResourceKey, type WorkflowDefinition } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import type { Locale } from '../../i18n/types'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { globalEventBus } from '../../shared/event-bus'
import {
  decodeBlueprintSemanticPayload,
  parseBlueprintSemanticResponseText,
  type BlueprintSemanticItem,
} from '../../shared/blueprint-semantic-contract'
import { structuredContractDiagnostic } from '../../shared/structured-contract-diagnostic'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../../shared/project-session-context'
import { ipc } from '../ipc-client'
import { PromptBudgetExceededError } from '../generation/generation-harness'
import type {
  BlueprintData,
  BlueprintRangeCommitMode,
  BlueprintRangeCommitReceipt,
} from '../../../electron/repositories/blueprint-repository'
import { stripThinkingTags } from './workflow-utils'
import { requireWorkflowProjectSession } from './workflow-project-session'

// ==========================================
// 1. 结构与类型导出 (保留对外的向后兼容)
// ==========================================

export type ChapterBlueprint = BlueprintData

export interface DirectoryWorkflowParams {
  mode: 'full' | 'append'
  startChapter?: number
  count?: number
  /** 节奏/风格指导（可选） */
  pacingGuidance?: string
}

export interface DirectoryWorkflowProjectSnapshot {
  expectedProjectPath: string
  novelConfig: Readonly<{
    totalChapters: number
    globalGuidance?: string
    genre?: string
  }>
}

// ==========================================
// 2. 蓝图文件访问与工具函数
// ==========================================

function extractJsonPayload(content: string): string | null {
  const cleanContent = stripThinkingTags(content)
  const jsonStr = cleanContent.replace(/```json?\n?/gi, '').replace(/```\n?/g, '').trim()
  const firstBrace = jsonStr.indexOf('{')
  const firstBracket = jsonStr.indexOf('[')
  const lastBrace = jsonStr.lastIndexOf('}')
  const lastBracket = jsonStr.lastIndexOf(']')
  if (firstBrace === -1 && firstBracket === -1) return null
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    return lastBracket === -1 ? null : jsonStr.substring(firstBracket, lastBracket + 1)
  }
  return lastBrace === -1 ? null : jsonStr.substring(firstBrace, lastBrace + 1)
}

function persistedBlueprint(item: BlueprintSemanticItem): ChapterBlueprint {
  return {
    ...item,
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
  }
}

function chapterRange(startNum: number, endNum: number): number[] {
  return Array.from({ length: endNum - startNum + 1 }, (_, index) => startNum + index)
}

export function parseTextBlueprints(content: string, startNum: number, endNum: number): ChapterBlueprint[] {
  try {
    const payload = extractJsonPayload(content)
    if (!payload) return []
    const parsed: unknown = JSON.parse(payload)
    const candidates = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'blueprints' in parsed
      ? (parsed as { blueprints: unknown }).blueprints
      : parsed
    if (!Array.isArray(candidates)) return []
    const expected = candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
      const raw = candidate as Record<string, unknown>
      const chapter = Number(raw.chapterNumber ?? raw.chapter_number)
      return Number.isSafeInteger(chapter) && chapter >= startNum && chapter <= endNum ? [chapter] : []
    })
    if (expected.length === 0 || new Set(expected).size !== expected.length) return []
    const filtered = candidates.filter((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
      const raw = candidate as Record<string, unknown>
      return expected.includes(Number(raw.chapterNumber ?? raw.chapter_number))
    })
    return decodeBlueprintSemanticPayload(filtered, expected).map(persistedBlueprint)
  } catch {
    console.error('Failed to parse blueprint JSON', content)
  }

  return []
}

export function parseTextBlueprintsStrict(content: string, startNum: number, endNum: number): ChapterBlueprint[] {
  try {
    return parseBlueprintSemanticResponseText(
      stripThinkingTags(content),
      chapterRange(startNum, endNum),
    ).map(persistedBlueprint)
  } catch (error) {
    if (structuredContractDiagnostic(error)) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`蓝图 JSON 解析失败：${detail}`)
  }
}

export function assertBlueprintCoverage(
  blueprints: ChapterBlueprint[],
  startChapter: number,
  endChapter: number,
): void {
  const chapterSet = new Set(blueprints.map((item) => item.chapterNumber))
  const missing: number[] = []
  for (let chapter = startChapter; chapter <= endChapter; chapter++) {
    if (!chapterSet.has(chapter)) missing.push(chapter)
  }

  if (missing.length > 0) {
    throw new Error(`蓝图生成缺少目标章节：第 ${missing.join('、')} 章`)
  }
}

export async function loadDirectoryBlueprints(
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<ChapterBlueprint[]> {
  const blueprints = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', expectedProjectPath)
  return blueprints.sort((a, b) => a.chapterNumber - b.chapterNumber)
}

function assertIpcSuccess(result: { success: boolean; error?: string }, action: string): void {
  if (!result.success) {
    throw new Error(result.error || `${action}失败`)
  }
}

export async function saveChapterBlueprint(
  blueprint: ChapterBlueprint,
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<void> {
  const result = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-upsert', blueprint, expectedProjectPath)
  assertIpcSuccess(result, '保存章节蓝图')
}

export async function saveAllBlueprints(
  blueprints: ChapterBlueprint[],
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<void> {
  const result = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-upsert-many', blueprints, expectedProjectPath)
  assertIpcSuccess(result, '保存章节蓝图')
}

export async function commitDirectoryBlueprintRange(
  blueprints: ChapterBlueprint[],
  expectedProjectPath: string,
  range: { mode: BlueprintRangeCommitMode; startChapter: number; endChapter: number },
  operationId: string,
  projectSession: ProjectSessionContext,
): Promise<BlueprintRangeCommitReceipt> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'db:blueprint-commit-range',
    {
      mode: range.mode,
      operationId,
      startChapter: range.startChapter,
      endChapter: range.endChapter,
      blueprints,
    },
    expectedProjectPath,
  )
  if (!result.success || !result.receipt) {
    throw new Error(result.error || '提交章节蓝图失败')
  }
  globalEventBus.emit('REFRESH_RESOURCE', {
    resources: ['blueprints'],
    projectPath: expectedProjectPath,
    projectSession,
  })
  return result.receipt
}

export async function verifyBlueprintsPersisted(
  blueprints: ChapterBlueprint[],
  expectedProjectPath: string,
  expectedRange?: { startChapter: number; endChapter: number },
  projectSession?: ProjectSessionContext,
): Promise<void> {
  if (!projectSession) throw new Error('验证章节蓝图时缺少冻结项目会话')
  if (expectedRange) {
    assertBlueprintCoverage(blueprints, expectedRange.startChapter, expectedRange.endChapter)
  }

  for (const blueprint of blueprints) {
    const saved = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', blueprint.chapterNumber, expectedProjectPath)
    if (!saved) {
      throw new Error(`蓝图保存后验证失败：第 ${blueprint.chapterNumber} 章未写入数据库`)
    }
    if (
      saved.title !== blueprint.title ||
      saved.role !== blueprint.role ||
      saved.purpose !== blueprint.purpose ||
      saved.keyEvents !== blueprint.keyEvents ||
      saved.suspenseHook !== blueprint.suspenseHook
    ) {
      throw new Error(`蓝图保存后验证失败：第 ${blueprint.chapterNumber} 章内容与本次生成结果不一致`)
    }
  }
}

export async function getBlueprintCount(
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<number> {
  try {
    const blueprints = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', expectedProjectPath)
    return blueprints.length
  } catch {
    return 0
  }
}

// ==========================================
// 3. 工作流定义映射工厂 (Command 调度层)
// ==========================================

export function createDirectoryWorkflow(
  params: DirectoryWorkflowParams,
  expectedProjectPath: string,
  sourceProjectSession: ProjectSessionContext,
  frozenUiLocale: Locale = useLocaleStore.getState().locale,
): WorkflowDefinition {
  const text = (zhCNText: string, enUSText: string) => frozenUiLocale === 'en-US' ? enUSText : zhCNText
  const projectAtStart = useProjectStore.getState().currentProject
  const currentProjectSession = projectSessionContextFromProject(projectAtStart)
  if (
    !projectAtStart
    || !currentProjectSession
    || !sameProjectPathKey(projectAtStart.path, expectedProjectPath)
    || !sameProjectSessionContext(sourceProjectSession, currentProjectSession)
  ) {
    throw new Error(text(
      '项目已切换，无法启动章节蓝图生成',
      'The project changed, so chapter-blueprint generation could not start.',
    ))
  }
  const projectSession = Object.freeze({ ...sourceProjectSession })
  const projectSnapshot: DirectoryWorkflowProjectSnapshot = {
    expectedProjectPath,
    novelConfig: {
      totalChapters: projectAtStart.novelConfig.totalChapters,
      globalGuidance: projectAtStart.novelConfig.globalGuidance,
      genre: projectAtStart.novelConfig.genre,
    },
  }

  return {
    type: 'directory',
    uiLocale: frozenUiLocale,
    title: params.mode === 'append'
      ? text(
        `续写章节蓝图${params.startChapter ? `（从第 ${params.startChapter} 章）` : ''}`,
        `Continue chapter blueprints${params.startChapter ? ` (from chapter ${params.startChapter})` : ''}`,
      )
      : text('生成章节蓝图（全量）', 'Generate chapter blueprints (all)'),
    projectPath: expectedProjectPath,
    projectSession,
    resourceKeys: [
      workflowResourceKey('blueprints'),
      workflowResourceKey('character-roster'),
    ],
    readResourceKeys: [
      workflowResourceKey('novel-config'),
      workflowResourceKey('architecture'),
    ],
    steps: [
      {
        name: text('读取架构', 'Read architecture'),
        description: text('从 SQLite 加载项目架构信息', 'Load the project architecture from SQLite'),
        executor: async (_step, context, callbacks) => {
          callbacks.log(text('读取项目架构信息...', 'Loading project architecture...'))
          const projectSession = requireWorkflowProjectSession(context)
          const core = await ipc.invokeWithProjectSession(
            projectSession,
            'db:project-core-get',
            expectedProjectPath,
          )
          if (!core) throw new Error(text(
            '项目核心数据未初始化',
            'Project core data has not been initialized.',
          ))

          const parts: string[] = []
          if (core.premise && core.premise.length > 50) parts.push(core.premise)
          if (core.charactersArch && core.charactersArch.length > 50) parts.push(core.charactersArch)
          if (core.worldbuilding && core.worldbuilding.length > 50) parts.push(core.worldbuilding)
          if (core.synopsis && core.synopsis.length > 50) parts.push(core.synopsis)

          if (parts.length === 0) throw new Error(text(
            '项目主要架构均未生成',
            'The main story architecture has not been generated yet.',
          ))

          context.data.architecture = parts.join('\n\n---\n\n')
          // 注入节奏指导到 context，供 Command 读取
          if (params.pacingGuidance) context.data.pacingGuidance = params.pacingGuidance
          if (params.mode === 'append') {
            const existing = await loadDirectoryBlueprints(expectedProjectPath, projectSession)
            context.data.existingBlueprints = existing
            callbacks.log(text(
              `已加载 ${existing.length} 章已有蓝图`,
              `Loaded ${existing.length} existing chapter blueprint${existing.length === 1 ? '' : 's'}`,
            ))
          }
          return text(
            `架构加载完成（${parts.length} 段）`,
            `Architecture loaded (${parts.length} section${parts.length === 1 ? '' : 's'})`,
          )
        },
      },
      {
        name: text('生成蓝图', 'Generate blueprints'),
        description: text(
          '基于架构文件生成、完整验证并原子提交章节蓝图',
          'Generate, fully validate, and atomically commit chapter blueprints from the architecture',
        ),
        executor: async (_step, context, callbacks) => {
          const directoryCommand = await import('./commands/directory.command')
          const cmd = new directoryCommand.GenerateDirectoryCommand(params, projectSnapshot)
          let blueprints: ChapterBlueprint[]
          try {
            blueprints = await cmd.execute({ step: _step, context, callbacks })
          } catch (error) {
            if (error instanceof PromptBudgetExceededError) throw error
            if (error instanceof directoryCommand.DirectoryPostCommitSyncError) {
              throw new Error(text(
                '章节蓝图已保存，但角色同步失败。请重试角色同步。',
                'Chapter blueprints were saved, but character synchronization failed. Retry character synchronization.',
              ))
            }
            if (error instanceof directoryCommand.DirectoryPostCommitCancellationError) {
              throw new Error(text(
                '章节蓝图已保存，但任务取消后角色同步可能未完成。',
                'Chapter blueprints were saved, but character synchronization may be incomplete because the workflow was cancelled.',
              ))
            }
            if (error instanceof directoryCommand.DirectoryCostLimitError) {
              throw new Error(text(
                '本次章节范围过大，请拆分为更小的范围生成。',
                'The requested chapter range is too large. Generate a smaller range.',
              ))
            }
            if (context.cancelled) {
              throw new Error(text('工作流已取消', 'Workflow was cancelled.'))
            }
            throw new Error(text(
              '章节蓝图生成失败，请重试。',
              'Chapter-blueprint generation failed. Please try again.',
            ))
          }
          // 返回可读摘要字符串（step.result 必须是 string，否则 AIOutputPanel 渲染会崩溃）
          return text(
            `已生成 ${blueprints.length} 章蓝图`,
            `Generated ${blueprints.length} chapter blueprint${blueprints.length === 1 ? '' : 's'}`,
          )
        },
      },
    ],
    onComplete: {
      mode: 'silent',
      message: params.mode === 'append'
        ? text('续写蓝图生成完成', 'Chapter blueprint continuation completed')
        : text('全书章节蓝图已生成完成。', 'All chapter blueprints have been generated.'),
    },
  }
}
