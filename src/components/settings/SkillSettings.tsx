import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Download, Link2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import {
  WRITING_SKILL_STAGES,
  type RemoteWritingSkillInspection,
  type WritingSkillStage,
} from '../../shared/writing-skills'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../../services/ipc-client'
import { skillRegistry, type LoadedSkill } from '../../services/agent/skill-registry'
import {
  loadWritingSkillBindings,
  saveWritingSkillBinding,
} from '../../services/agent/writing-skill-bindings'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { NativeSelect } from '../ui/NativeSelect'
import { confirm as confirmAction } from '../ui/Confirm'

const STAGE_COPY: Record<WritingSkillStage, readonly [string, string]> = {
  planning: ['设定与规划', 'Planning'],
  drafting: ['章节正文', 'Chapter drafting'],
  review: ['AI 审稿', 'AI review'],
  refinement: ['修稿与定稿前润色', 'Revision and pre-final polish'],
}

const SOURCE_COPY = {
  builtin: ['内置', 'Built-in'],
  user: ['用户', 'User'],
  project: ['项目', 'Project'],
} as const

const REASON_COPY: Record<string, readonly [string, string]> = {
  'relative-reference': ['包含相对引用', 'Contains relative references'],
  'script-dependency': ['依赖脚本', 'Requires scripts'],
  'hook-dependency': ['依赖 hook', 'Requires hooks'],
  'subagent-dependency': ['依赖子代理', 'Requires subagents'],
  'tool-dependency': ['依赖工具调用', 'Requires tool calls'],
  'content-too-large': ['内容超过 64 KiB', 'Content exceeds 64 KiB'],
}

const BUILTIN_SKILL_COPY_EN: Record<string, readonly [string, string]> = {
  'builtin:long-form-continuity': [
    'Long-form Continuity and Scene Progression',
    'Preserves author facts, causal chains, character state, and foreshadowing progress during planning and drafting.',
  ],
  'builtin:natural-prose-refinement': [
    'Natural Prose Refinement',
    'Reduces formulaic phrasing during revision so actions, sensory details, and sentence rhythm serve the characters and scene.',
  ],
  'builtin:review-chapter': [
    'Chapter Review',
    'Reviews a chapter for plot logic, character consistency, pacing, foreshadowing, and prose quality.',
  ],
  'builtin:brainstorm': [
    'Creative Brainstorming',
    'Generates multiple creative directions and ideas for a chosen topic.',
  ],
  'builtin:character-analysis': [
    'Character Analysis',
    'Analyzes a character\'s personality, motivation, arc, and relationships in depth.',
  ],
  'builtin:continuity-check': [
    'Continuity Check',
    'Checks the novel for continuity and setting inconsistencies, contradictions, and omissions.',
  ],
  'builtin:writing-coach': [
    'Writing Coach',
    'Provides professional writing guidance and suggestions for improving prose.',
  ],
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`
}

function skillLabel(skill: LoadedSkill): string {
  return skill.metadata.displayName ?? skill.metadata.name
}

function localizedSkillLabel(skill: LoadedSkill, text: (zhCN: string, enUS: string) => string): string {
  const copy = BUILTIN_SKILL_COPY_EN[skill.skillId]
  return copy ? text(skillLabel(skill), copy[0]) : skillLabel(skill)
}

function localizedSkillDescription(skill: LoadedSkill, text: (zhCN: string, enUS: string) => string): string {
  const copy = BUILTIN_SKILL_COPY_EN[skill.skillId]
  return copy ? text(skill.metadata.description, copy[1]) : skill.metadata.description
}

function stageCopy(text: (zhCN: string, enUS: string) => string, stage: WritingSkillStage): string {
  const copy = STAGE_COPY[stage]
  return text(copy[0], copy[1])
}

export default function SkillSettings() {
  const text = useLocaleStore(state => state.text)
  const project = useProjectStore(state => state.currentProject)
  const projectSession = useMemo(() => projectSessionContextFromProject(project), [project])
  const [skills, setSkills] = useState<LoadedSkill[]>([])
  const [bindings, setBindings] = useState<Partial<Record<WritingSkillStage, string>>>({})
  const [sourceUrl, setSourceUrl] = useState('')
  const [inspection, setInspection] = useState<RemoteWritingSkillInspection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = async (session: ProjectSessionContext | null = projectSession) => {
    await skillRegistry.loadAll()
    setSkills(skillRegistry.listAll())
    if (session) {
      const loaded = await loadWritingSkillBindings(session)
      setBindings(loaded.bindings)
    } else {
      setBindings({})
    }
  }

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        await skillRegistry.loadAll()
        if (disposed) return
        setSkills(skillRegistry.listAll())
        if (projectSession) {
          const loaded = await loadWritingSkillBindings(projectSession)
          if (!disposed) setBindings(loaded.bindings)
        } else setBindings({})
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { disposed = true }
  }, [projectSession])

  const inspectSource = async () => {
    setBusy(true)
    setError(null)
    setInspection(null)
    try {
      const result = await ipc.invoke('skills:inspect-github', sourceUrl.trim())
      if (!result.success || !result.inspection) throw new Error(result.error || text('Skill 检查失败', 'Skill inspection failed'))
      setInspection(result.inspection)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const installSource = async () => {
    if (!inspection?.compatible) return
    if (!await confirmAction(text(
      `确认把“${inspection.metadata.name}”安装到全局写作 Skill 库？安装时会重新下载并验证。`,
      `Install “${inspection.metadata.name}” in the global writing skill library? It will be downloaded and validated again.`,
    ), { title: text('安装写作 Skill', 'Install writing skill') })) return
    setBusy(true)
    setError(null)
    try {
      const result = await ipc.invoke('skills:install-github', inspection.sourceUrl)
      if (!result.success) throw new Error(result.error || text('Skill 安装失败', 'Skill installation failed'))
      await reload()
      setInspection(null)
      setSourceUrl('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const updateBinding = async (stage: WritingSkillStage, skillId: string) => {
    if (!projectSession) return
    setBusy(true)
    setError(null)
    try {
      await saveWritingSkillBinding(projectSession, stage, skillId || null)
      setBindings(previous => {
        const next = { ...previous }
        if (skillId) next[stage] = skillId
        else delete next[stage]
        return next
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const uninstall = async (skill: LoadedSkill) => {
    if (skill.source !== 'user') return
    if (!await confirmAction(text(
      `卸载“${skillLabel(skill)}”？当前项目中的绑定也会解除。`,
      `Uninstall “${skillLabel(skill)}”? Its bindings in the current project will also be removed.`,
    ), { title: text('卸载写作 Skill', 'Uninstall writing skill'), danger: true })) return
    setBusy(true)
    setError(null)
    try {
      if (projectSession) {
        for (const stage of WRITING_SKILL_STAGES) {
          if (bindings[stage] === skill.skillId) await saveWritingSkillBinding(projectSession, stage, null)
        }
      }
      const result = await ipc.invoke('skills:uninstall-user', skill.metadata.name)
      if (!result.success) throw new Error(result.error || text('Skill 卸载失败', 'Skill uninstall failed'))
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const compatibleSkills = skills.filter(skill => skill.writingSkill.compatible)

  return (
    <div className="space-y-5">
      <section className="space-y-2" aria-labelledby="writing-skill-source-title">
        <div>
          <h3 id="writing-skill-source-title" className="text-sm font-semibold text-[var(--color-text)]">
            {text('从 GitHub 检查写作 Skill', 'Inspect a writing skill from GitHub')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            {text('仅支持自包含的提示词型 SKILL.md。脚本、hook、相对引用、子代理和工具执行要求不会被安装。', 'Only self-contained prompt SKILL.md files are supported. Scripts, hooks, relative references, subagents, and tool requirements are not installed.')}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Link2 size={14} className="absolute left-2.5 top-2 text-[var(--color-text-muted)]" />
            <Input
              value={sourceUrl}
              onChange={event => setSourceUrl(event.target.value)}
              placeholder="https://github.com/owner/repository"
              aria-label={text('GitHub Skill 地址', 'GitHub skill URL')}
              className="pl-8"
            />
          </div>
          <Button variant="outline" onClick={inspectSource} disabled={busy || !sourceUrl.trim()}>
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
            {text('只读检查', 'Inspect')}
          </Button>
        </div>
        {inspection && (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3">
            <div className="flex items-start gap-3">
              {inspection.compatible
                ? <ShieldCheck size={17} className="mt-0.5 shrink-0 text-[var(--color-success-text)]" />
                : <AlertTriangle size={17} className="mt-0.5 shrink-0 text-[var(--color-warning-text)]" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--color-text)]">{inspection.metadata.name}</div>
                <p className="mt-0.5 text-xs leading-5 text-[var(--color-text-muted)]">{inspection.metadata.description}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-secondary)]">
                  <span>{text('建议阶段', 'Suggested stage')}: {stageCopy(text, inspection.suggestedStage)}</span>
                  <span>{text('语言', 'Language')}: {inspection.metadata.language}</span>
                  <span>{text('大小', 'Size')}: {formatBytes(inspection.utf8Bytes)}</span>
                </div>
                {!inspection.compatible && (
                  <p role="alert" className="mt-2 text-xs text-[var(--color-warning-text)]">
                    {inspection.reasons.map((reason) => {
                      const copy = REASON_COPY[reason]
                      return copy ? text(copy[0], copy[1]) : reason
                    }).join('；')}
                  </p>
                )}
              </div>
              <Button onClick={installSource} disabled={busy || !inspection.compatible}>
                <Download size={13} />
                {text('确认安装', 'Confirm install')}
              </Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-xs text-[var(--color-error-text)]">{error}</p>}
      </section>

      <section className="space-y-3" aria-labelledby="writing-skill-bindings-title">
        <div>
          <h3 id="writing-skill-bindings-title" className="text-sm font-semibold text-[var(--color-text)]">
            {text('当前项目阶段绑定', 'Current project stage bindings')}
          </h3>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {projectSession
              ? text('每个阶段最多启用一个 Skill；工作流启动时会冻结当次内容。', 'Each stage uses at most one skill; its content is frozen when the workflow starts.')
              : text('请先打开项目再绑定 Skill。', 'Open a project to bind skills.')}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {WRITING_SKILL_STAGES.map(stage => (
            <label key={stage} className="space-y-1 text-xs text-[var(--color-text-secondary)]">
              <span>{stageCopy(text, stage)}</span>
              <NativeSelect
                value={bindings[stage] ?? ''}
                onChange={event => updateBinding(stage, event.target.value)}
                disabled={busy || !projectSession}
                aria-label={text(`${STAGE_COPY[stage][0]} Skill`, `${STAGE_COPY[stage][1]} skill`)}
              >
                <option value="">{text('不启用', 'Disabled')}</option>
                {compatibleSkills.map(skill => (
                  <option key={skill.skillId} value={skill.skillId}>{localizedSkillLabel(skill, text)}</option>
                ))}
              </NativeSelect>
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-2" aria-labelledby="writing-skill-library-title">
        <h3 id="writing-skill-library-title" className="text-sm font-semibold text-[var(--color-text)]">
          {text('Skill 库', 'Skill library')}
        </h3>
        {skills.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] py-8 text-center text-xs text-[var(--color-text-muted)]">
            {text('暂无可用 Skill', 'No skills available')}
          </div>
        ) : skills.map(skill => {
          const activeStages = WRITING_SKILL_STAGES.filter(stage => bindings[stage] === skill.skillId)
          return (
            <div key={skill.skillId} className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-[var(--color-text)]">{localizedSkillLabel(skill, text)}</span>
                  <span className="rounded-full bg-[var(--color-hover)] px-2 py-0.5 text-[0.68rem] text-[var(--color-text-muted)]">
                    {text(SOURCE_COPY[skill.source][0], SOURCE_COPY[skill.source][1])}
                  </span>
                  <span className={`text-[0.68rem] ${skill.writingSkill.compatible ? 'text-[var(--color-success-text)]' : 'text-[var(--color-warning-text)]'}`}>
                    {skill.writingSkill.compatible ? text('兼容', 'Compatible') : text('不兼容', 'Incompatible')}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{localizedSkillDescription(skill, text)}</p>
                <div className="mt-1 flex flex-wrap gap-x-4 text-[0.7rem] text-[var(--color-text-secondary)]">
                  <span>{text('版本', 'Version')}: {skill.metadata.version ?? '—'}</span>
                  <span>{text('语言', 'Language')}: {skill.writingSkill.metadata.language}</span>
                  <span>{text('大小', 'Size')}: {formatBytes(skill.writingSkill.utf8Bytes)}</span>
                  <span>{text('启用阶段', 'Enabled stage')}: {activeStages.length ? activeStages.map(stage => stageCopy(text, stage)).join(text('、', ', ')) : text('未启用', 'None')}</span>
                </div>
              </div>
              {skill.source === 'user' && (
                <Button variant="ghost" size="icon" onClick={() => uninstall(skill)} disabled={busy} aria-label={text(`卸载 ${skillLabel(skill)}`, `Uninstall ${skillLabel(skill)}`)}>
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}
