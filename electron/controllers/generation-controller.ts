import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type Database from 'better-sqlite3'
import type { GenerationOwnerChannels } from '../../src/shared/generation-owner-contract'
import type { ModelProfile, ProjectSessionContext } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import { getBuiltinPromptTemplate } from '../../src/services/builtin-prompt-templates'
import { readBuiltinWritingSkill } from '../../src/shared/builtin-writing-skills'
import { getProjectDb, getCurrentProjectPath, onProjectDatabaseBeforeClose } from '../database'
import { getGlobalDataRoot } from '../services/app-data-locator'
import { getProjectDataRoot } from '../services/project-data-locator'
import { projectAccess } from '../services/project-access'
import { ModelExecutionLeaseRegistry } from '../services/model-execution-lease'
import { createMainGenerationOwner } from '../services/main-generation-owner'
import { MAIN_GENERATION_POLICY } from '../services/main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../services/generation-source-binding'

export function registerGenerationController(options: {
  modelExecutionLeases: ModelExecutionLeaseRegistry
  loadModel: (id: string) => ModelProfile | null
  applyProxyConfig: () => void
}) {
  type Owner = ReturnType<typeof createMainGenerationOwner>
  const owners = new Map<Database.Database, { owner: Owner; session: ProjectSessionContext; subscribers: Set<WebContents> }>()
  onProjectDatabaseBeforeClose(({ database }) => {
    const entry = owners.get(database)
    if (entry) { entry.owner.suspendForProjectClose(); owners.delete(database) }
  })
  const authorizedOwner = (session: ProjectSessionContext, event: IpcMainInvokeEvent) => {
    projectAccess.assertCurrentProjectContext(session, getCurrentProjectPath())
    const database = getProjectDb()
    if (!database) throw new Error('GENERATION_DATABASE_NOT_READY')
    let entry = owners.get(database)
    if (entry && (entry.session.projectId !== session.projectId || entry.session.leaseId !== session.leaseId)) {
      entry.owner.suspendForProjectClose()
      owners.delete(database)
      entry = undefined
    }
    if (!entry) {
      const captured = Object.freeze({ ...session })
      const subscribers = new Set<WebContents>()
      const sourceDependencies = { db: database, projectStorageRoot: getProjectDataRoot(captured.projectPath),
        globalDataRoot: getGlobalDataRoot(), readBuiltinSkill: readBuiltinWritingSkill,
        readBuiltinPrompt: (key: string, language: 'zh-CN' | 'en-US') => {
          const template = getBuiltinPromptTemplate(key, language)
          if (!template) throw new Error('GENERATION_BUILTIN_PROMPT_MISSING')
          return JSON.stringify(template)
        } }
      const owner = createMainGenerationOwner({ database, projectId: captured.projectId, epoch: captured.leaseId,
        assertCurrent: () => { projectAccess.assertCurrentProjectContext(captured, getCurrentProjectPath());
          if (getProjectDb() !== database) throw new Error('GENERATION_DATABASE_CHANGED') },
        leases: options.modelExecutionLeases, loadModel: options.loadModel, beforeDispatch: options.applyProxyConfig,
        buildBinding: (selection, modelReceipt) => buildGenerationSourceBinding(sourceDependencies, { ...selection,
          projectId: captured.projectId, epoch: captured.leaseId, modelReceipt, policy: MAIN_GENERATION_POLICY, outputContract: selection.output }).binding,
        rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDependencies, previous, captured.leaseId,
          modelReceipt, MAIN_GENERATION_POLICY).binding,
        onSnapshot: snapshot => { for (const subscriber of subscribers) {
          if (subscriber.isDestroyed()) subscribers.delete(subscriber)
          else subscriber.send('generation:snapshot', snapshot)
        } },
      })
      entry = { owner, session: captured, subscribers }
      owners.set(database, entry)
    }
    entry.subscribers.add(event.sender)
    return entry.owner
  }
  function register<C extends keyof GenerationOwnerChannels>(channel: C, arity: number,
    handler: (owner: Owner, ...args: GenerationOwnerChannels[C]['args']) => GenerationOwnerChannels[C]['return'] | Promise<GenerationOwnerChannels[C]['return']>) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      try {
        const session = raw.pop()
        if (!isProjectSessionContext(session) || raw.length !== arity) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
        const result = await handler(authorizedOwner(session, event), ...raw as GenerationOwnerChannels[C]['args'])
        projectAccess.assertCurrentProjectContext(session, getCurrentProjectPath())
        return result
      } catch (error) {
        const code = error instanceof Error && /^(?:GENERATION|ROOT_BUDGET|ARTIFACT|MAIN)_[A-Z_]+$/u.test(error.message)
          ? error.message : 'GENERATION_REQUEST_FAILED'
        throw new Error(code)
      }
    })
  }
  register('generation:begin', 1, (owner, request) => owner.begin(request))
  register('generation:execute', 1, (owner, request) => owner.execute(request))
  register('generation:read', 1, (owner, handle) => owner.read(handle))
  register('generation:list', 0, owner => owner.list())
  register('generation:pause', 1, (owner, handle) => owner.pause(handle))
  register('generation:cancel', 1, (owner, handle) => owner.cancel(handle))
  register('generation:resume', 1, (owner, handle) => owner.resume(handle))
  register('generation:restart', 2, (owner, handle, request) => owner.restart(handle, request))
  register('generation:discard-candidate', 2, (owner, handle, artifactId) => owner.discardCandidate(handle, artifactId))
}
