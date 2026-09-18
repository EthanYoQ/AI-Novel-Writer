import { createLegacyRosterGeneration } from '../../legacy-roster-generation'
import { formatCharacterProposalPreview } from '../character-proposal-preview'
import { useLLMStore } from '../../../stores/llm-store'
import type { MainGenerationRunHandle } from '../../generation/generation-runtime'
import { buildLegacyRosterTask, buildLegacyRosterJsonRepairTask } from '../../../shared/legacy-roster-generation-pure'
import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../ipc-client'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
  sameProjectPathKey,
} from '../../../shared/project-session-context'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'
import {
  CHARACTER_ROSTER_SCHEMA_VERSION,
  type CharacterRosterCommitRequest,
  type CharacterRosterEntry,
  type CharacterRosterSnapshot,
} from '../../../shared/character-roster'
import { globalEventBus } from '../../../shared/event-bus'
import {
  CHARACTER_ROSTER_JSON_REPAIR_SYSTEM,
  parseCharacterRosterJsonResponse,
} from './character-roster-json-contract'

function assertLegacyRepairSessionCurrent(projectSession: CommandExecuteParams['context']['projectSession']): void {
  if (!sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) {
    throw new Error('当前项目已切换，旧角色图谱修复已停止以避免写入错误项目')
  }
}

function assertRepairRequired(snapshot: CharacterRosterSnapshot): asserts snapshot is CharacterRosterSnapshot & {
  status: 'legacy_repair_required'
  legacyMarkdown: string
} {
  if (snapshot.status === 'inconsistent') {
    throw new Error('角色名单状态不一致，未改动任何角色数据。请保留项目后联系支持。')
  }
  if (snapshot.status !== 'legacy_repair_required' || !snapshot.legacyMarkdown?.trim()) {
    throw new Error('当前项目不需要旧角色图谱修复；已有角色卡会被保留，不会从 Markdown 覆盖。')
  }
  if (snapshot.entries.length !== 0) {
    throw new Error('已有角色卡会被保留，旧角色图谱修复已拒绝覆盖。')
  }
}

function assertExistingCardsAdoptionRequired(snapshot: CharacterRosterSnapshot): void {
  if (snapshot.migrationState !== 'legacy_cards_preserved' || snapshot.entries.length === 0) {
    throw new Error('当前项目没有可安全采用的既有角色卡，未改动任何角色数据。')
  }
  // legacy_cards_preserved 在 #82 中刻意显示为 inconsistent，提醒作者先由
  // 结构化卡片重建一次只读图谱；它不是“从 Markdown 重新提取角色”。
  if (snapshot.status !== 'inconsistent') {
    throw new Error('既有角色卡的采用状态异常，未改动任何角色数据。')
  }
}

function assertCommittedRosterReadable(
  receipt: { snapshot?: CharacterRosterSnapshot } | undefined,
  candidateEntries: unknown,
  expectedLegacyMarkdown: string,
): asserts receipt is { snapshot: CharacterRosterSnapshot } {
  const snapshot = receipt?.snapshot
  if (
    !snapshot
    || snapshot.status !== 'ready'
    || snapshot.migrationState !== 'ready'
    || snapshot.entries.length === 0
    || !snapshot.renderedMarkdown.trim()
    || snapshot.legacyMarkdown !== expectedLegacyMarkdown
  ) {
    throw new Error('旧角色图谱修复提交后未能回读角色卡和角色图谱，未将本步骤标记为成功')
  }
  if (!Array.isArray(candidateEntries)) return
  const candidateNames = candidateEntries
    .map(entry => (
      entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
        ? (entry as { name: string }).name.trim()
        : ''
    ))
    .filter(Boolean)
  const committedNames = new Set(snapshot.entries.map(entry => entry.name.trim()).filter(Boolean))
  if (candidateNames.length === 0 || candidateNames.some(name => !committedNames.has(name))) {
    throw new Error('旧角色图谱修复回读不完整，未将本步骤标记为成功')
  }
}

export interface LegacyCharacterRosterRepairInput {
  expectedProjectPath: string
  genre: string
  recoveryHandle?: MainGenerationRunHandle
  restart?: boolean
  expectedMode?: 'existing' | 'model'
}

/**
 * 旧版项目的显式、安全修复命令。
 *
 * 它不读取 project_core.characters_arch 来猜测事实，也不调用旧的
 * character-card-normalizer；唯一写路径是 CharacterRosterRepository 的原子
 * read/commit seam。
 */
export class RepairLegacyCharacterRosterCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly input: LegacyCharacterRosterRepairInput,
    private readonly explicitDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(explicitDependencies)
  }

  private async parseResponse(
    rawText: string,
    callbacks: CommandExecuteParams['callbacks'],
    context: CommandExecuteParams['context'],
  ): Promise<{ schemaVersion: unknown; entries: unknown }> {
    return parseCharacterRosterJsonResponse(rawText, {
      parseJson: text => this.parseJSON<unknown>(text),
      assertNotCancelled: () => this.assertNotCancelled(context),
      log: message => callbacks.log(message),
      repair: () => {
        const task = buildLegacyRosterJsonRepairTask(rawText)
        return this.callLLMWithBoundedCompletion(
          task.messages[1]!.content,
          task.messages[0]!.content,
          callbacks,
          { mode: 'replace-structured-output', maxContinuations: 2 },
          {
            responseFormat: { type: 'json_object' },
            purpose: task.purpose,
            reasoningStage: task.reasoningStage,
          },
          context,
        )
      },
    }, {
      repairSystemPrompt: CHARACTER_ROSTER_JSON_REPAIR_SYSTEM,
      repairPurpose: 'legacy-character-roster-json-repair',
    })
  }

  private async adoptExistingCards(
    sourceSnapshot: CharacterRosterSnapshot,
    projectSession: CommandExecuteParams['context']['projectSession'],
    context: CommandExecuteParams['context'],
    callbacks: CommandExecuteParams['callbacks'],
  ): Promise<string> {
    const { expectedProjectPath } = this.input
    assertExistingCardsAdoptionRequired(sourceSnapshot)
    callbacks.log('正在校验既有角色卡并重建只读角色图谱...')
    this.assertNotCancelled(context)
    assertLegacyRepairSessionCurrent(projectSession)

    const currentSnapshot = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      expectedProjectPath,
    )
    this.assertNotCancelled(context)
    assertLegacyRepairSessionCurrent(projectSession)
    assertExistingCardsAdoptionRequired(currentSnapshot)
    if (currentSnapshot.legacyMarkdown !== sourceSnapshot.legacyMarkdown) {
      throw new Error('旧角色图谱已变更，未使用过期快照重建图谱')
    }

    const commitResult = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-commit',
      {
        operationId: context.runId,
        expectedRevision: currentSnapshot.revision,
        schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION,
        // adoption 不信任 renderer 回传的自由文本字段；主进程会只读取已有
        // characters 表并重建投影。这里仅提交身份集合做并发校验。
        entries: currentSnapshot.entries.map((entry) => {
          const structuredEntry = { ...entry }
          delete structuredEntry.legacyRelationshipNotes
          return structuredEntry
        }),
        intent: 'legacy_cards_adoption',
        expectedLegacyMarkdown: currentSnapshot.legacyMarkdown ?? '',
      } satisfies CharacterRosterCommitRequest,
      expectedProjectPath,
    )
    if (!commitResult.success) {
      throw new Error(commitResult.error || '既有角色卡采用失败，未改动任何角色数据')
    }
    assertCommittedRosterReadable(
      commitResult.receipt,
      currentSnapshot.entries,
      currentSnapshot.legacyMarkdown ?? '',
    )

    const snapshot = commitResult.receipt.snapshot
    this.notifyRefresh(['characterCards'], expectedProjectPath, projectSession)
    globalEventBus.emit('ARCH_FILE_UPDATED', {
      fileName: 'characters.md',
      projectPath: expectedProjectPath,
      projectSession,
      runId: context.runId,
    })
    callbacks.log(`已采用 ${snapshot.entries.length} 张既有角色卡并重建只读角色图谱；旧原文已保留`)
    return snapshot.renderedMarkdown
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    if (this.explicitDependencies) return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
    return this.executeDedicated(params)
  }

  private async executeDedicated({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const session = requireWorkflowProjectSession(context)
    if (!sameProjectPathKey(session.projectPath, this.input.expectedProjectPath)) throw new Error('LEGACY_ROSTER_PROJECT_MISMATCH')
    assertLegacyRepairSessionCurrent(session)
    this.assertNotCancelled(context)
    const source = this.input.recoveryHandle ? undefined : await ipc.invokeWithProjectSession(session, 'legacy-roster:read-source')
    assertLegacyRepairSessionCurrent(session)
    this.assertNotCancelled(context)
    if (source && this.input.expectedMode && (source.snapshot.migrationState === 'legacy_cards_preserved' ? 'existing' : 'model') !== this.input.expectedMode) throw new Error('LEGACY_ROSTER_SOURCE_MODE_CHANGED')
    if (source && source.snapshot.migrationState === 'legacy_cards_preserved') {
      const result = await ipc.invokeWithProjectSession(session, 'legacy-roster:adopt-existing', {
        operationId: `legacy-cards:${context.runId}`, expectedRevision: source.snapshot.revision,
        expectedLegacyHash: source.legacyHash, expectedIdentityRevision: source.identityRevision,
        expectedFactsHash: source.factsHash,
      })
      assertLegacyRepairSessionCurrent(session)
      this.notifyRefresh(['characterCards'], session.projectPath, session)
      globalEventBus.emit('ARCH_FILE_UPDATED', { fileName: 'characters.md', projectPath: session.projectPath, projectSession: session, runId: context.runId })
      return result.snapshot.renderedMarkdown
    }
    let handle = this.input.recoveryHandle
    if (!handle && !this.input.restart) {
      const runs = await ipc.invokeWithProjectSession(session, 'generation:list')
      this.assertNotCancelled(context)
      assertLegacyRepairSessionCurrent(session)
      handle = runs.find(run => run.operation === 'legacy-character-roster-repair')?.handle
      if (handle) throw new Error('已有旧角色修复运行，请明确查看或恢复；重新开始须单独选择。')
    }
    const client = createLegacyRosterGeneration(session, () => { this.assertNotCancelled(context); assertLegacyRepairSessionCurrent(session) })
    const timer = setInterval(() => { if (context.cancelled) void client.cancel().catch(() => {}) }, 50)
    try {
      const current = await client.open(handle ? { handle } : {
        modelId: context.generationModelId || useLLMStore.getState().defaultModelId || '',
        uiActionNonce: `legacy-roster:${context.runId}`,
      })
      context.mainGenerationRunHandle = current.view.handle
      context.data.legacyRosterGenerationHandle = current.view.handle
      const completed = current.proposal ? current : await client.execute()
      this.assertNotCancelled(context)
      assertLegacyRepairSessionCurrent(session)
      context.mainGenerationRunHandle = completed.view.handle
      const batch = completed.proposal ?? await client.stage()
      context.data.characterProposalBatch = batch
      callbacks.setProgress(100)
      callbacks.log(workflowUiText(context, '候选已保存，等待明确采用；原始当前状态仅保留为候选，尚未写入定稿状态。', 'Candidates saved for explicit approval; original current state remains a candidate, not finalized state.'))
      return formatCharacterProposalPreview(batch, (zh, en) => workflowUiText(context, zh, en))
    } finally {
      clearInterval(timer)
      if (context.cancelled) await client.cancel().catch(() => {})
      client.detach()
    }
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    assertLegacyRepairSessionCurrent(projectSession)
    const { expectedProjectPath, genre } = this.input

    const sourceSnapshot = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      expectedProjectPath,
    )
    this.assertNotCancelled(context)
    assertLegacyRepairSessionCurrent(projectSession)
    if (sourceSnapshot.migrationState === 'legacy_cards_preserved') {
      return this.adoptExistingCards(sourceSnapshot, projectSession, context, callbacks)
    }
    assertRepairRequired(sourceSnapshot)
    const legacyMarkdown = sourceSnapshot.legacyMarkdown

    callbacks.log('正在将旧角色图谱转换为结构化角色名单...')
    const task = buildLegacyRosterTask({ legacyMarkdown, genre })
    const rosterJson = await this.callLLMWithBoundedCompletion(
      task.messages[1]!.content,
      task.messages[0]!.content,
      callbacks,
      { mode: 'replace-structured-output', maxContinuations: 2 },
      {
        responseFormat: { type: 'json_object' },
        purpose: task.purpose,
        reasoningStage: task.reasoningStage,
      },
      context,
    )
    if (!rosterJson.trim()) throw new Error('旧角色图谱修复失败，AI 返回空内容，未保存任何角色数据')

    const candidate = await this.parseResponse(rosterJson, callbacks, context)
    this.assertNotCancelled(context)
    assertLegacyRepairSessionCurrent(projectSession)

    // 模型运行期间作者可能已经手工创建角色卡或重新打开项目；重新读取快照后
    // 以 revision 和原始证据双门禁拒绝陈旧候选。
    const currentSnapshot = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      expectedProjectPath,
    )
    this.assertNotCancelled(context)
    assertLegacyRepairSessionCurrent(projectSession)
    assertRepairRequired(currentSnapshot)
    if (currentSnapshot.legacyMarkdown !== legacyMarkdown) {
      throw new Error('旧角色图谱已变更，未保存过期修复结果')
    }

    const commitResult = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-commit',
      {
        operationId: context.runId,
        expectedRevision: currentSnapshot.revision,
        schemaVersion: candidate.schemaVersion as typeof CHARACTER_ROSTER_SCHEMA_VERSION,
        entries: candidate.entries as CharacterRosterEntry[],
        intent: 'legacy_repair',
        expectedLegacyMarkdown: legacyMarkdown,
      } satisfies CharacterRosterCommitRequest,
      expectedProjectPath,
    )
    if (!commitResult.success) {
      throw new Error(commitResult.error || '旧角色图谱修复失败，未保存任何角色数据')
    }
    assertCommittedRosterReadable(commitResult.receipt, candidate.entries, legacyMarkdown)

    const snapshot = commitResult.receipt.snapshot
    // receipt 是持久化边界。之后即使用户按下取消，也不能谎称“零写入”；
    // 卡片和只读图谱已经同一事务提交并可立即刷新。
    this.notifyRefresh(['characterCards'], expectedProjectPath, projectSession)
    globalEventBus.emit('ARCH_FILE_UPDATED', {
      fileName: 'characters.md',
      projectPath: expectedProjectPath,
      projectSession,
      runId: context.runId,
    })
    callbacks.log(`旧角色图谱已安全修复为 ${snapshot.entries.length} 张角色卡；原文已保留`)
    return snapshot.renderedMarkdown
  }
}
