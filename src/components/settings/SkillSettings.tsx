import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Download, FolderOpen, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import {
  WRITING_SKILL_STAGES,
  type LocalWritingSkillInspection,
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
// 阶段名与内置 Skill 的显示名收在组件层的共享文案里：修稿 / 审稿确认弹窗的
// Skill 气泡也要显示同一批名字，各写一份迟早会漂移。
import {
  localizedSkillDescription,
  localizedSkillLabel,
  skillLabel,
  stageCopy,
  WRITING_SKILL_SOURCE_COPY as SOURCE_COPY,
  WRITING_SKILL_STAGE_COPY as STAGE_COPY,
} from '../skill-copy'

/**
 * 待确认的导入目标。
 *
 * 本地导入与 GitHub 安装共用同一张结果卡片与同一套内容检查；
 * 差别只在来源标识与确认文案：远程按 URL 重新下载，本地按路径重新读取并复核 SHA-256。
 */
type PendingSkillImport =
  | { source: 'github'; inspection: RemoteWritingSkillInspection }
  | { source: 'local'; inspection: LocalWritingSkillInspection }

const REASON_COPY: Record<string, readonly [string, string]> = {
  'relative-reference': ['包含相对引用', 'Contains relative references'],
  'script-dependency': ['依赖脚本', 'Requires scripts'],
  'hook-dependency': ['依赖 hook', 'Requires hooks'],
  'subagent-dependency': ['依赖子代理', 'Requires subagents'],
  'tool-dependency': ['依赖工具调用', 'Requires tool calls'],
  'content-too-large': ['内容超过 64 KiB', 'Content exceeds 64 KiB'],
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`
}

export default function SkillSettings() {
  const text = useLocaleStore(state => state.text)
  const project = useProjectStore(state => state.currentProject)
  const projectSession = useMemo(() => projectSessionContextFromProject(project), [project])
  const [skills, setSkills] = useState<LoadedSkill[]>([])
  const [bindings, setBindings] = useState<Partial<Record<WritingSkillStage, string>>>({})
  const [sourceUrl, setSourceUrl] = useState('')
  const [pending, setPending] = useState<PendingSkillImport | null>(null)
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

  /** 选本地文件只负责把路径回填到来源栏；是否检查由作者点「只读检查」决定。 */
  const pickLocalSource = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await ipc.invoke('skills:pick-local-file')
      if (!result.success) throw new Error(result.error || text('无法选择本地文件', 'Could not select a local file'))
      // 用户在文件选择器里取消：静默返回，不改动现有状态。
      if (result.cancelled || !result.filePath) return
      setSourceUrl(result.filePath)
      setPending(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  /** 来源栏既接受 GitHub 地址，也接受本地 SKILL.md 路径，两者各走自己的只读检查通道。 */
  const inspectSource = async () => {
    const source = sourceUrl.trim()
    if (!source) return
    setBusy(true)
    setError(null)
    setPending(null)
    try {
      if (/^https?:\/\//iu.test(source)) {
        const result = await ipc.invoke('skills:inspect-github', source)
        if (!result.success || !result.inspection) throw new Error(result.error || text('Skill 检查失败', 'Skill inspection failed'))
        setPending({ source: 'github', inspection: result.inspection })
      } else {
        const result = await ipc.invoke('skills:inspect-local', source)
        if (!result.success || !result.inspection) throw new Error(result.error || text('Skill 检查失败', 'Skill inspection failed'))
        setPending({ source: 'local', inspection: result.inspection })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const installPending = async () => {
    const current = pending
    if (!current || !current.inspection.compatible) return
    const confirmed = await confirmAction(
      current.source === 'local'
        ? text(
          `确认把“${current.inspection.metadata.name}”导入到全局写作 Skill 库？导入时会重新读取该文件并复核校验值。`,
          `Import “${current.inspection.metadata.name}” into the global writing skill library? The file is read again and its checksum re-verified.`,
        )
        : text(
          `确认把“${current.inspection.metadata.name}”安装到全局写作 Skill 库？安装时会重新下载并验证。`,
          `Install “${current.inspection.metadata.name}” in the global writing skill library? It will be downloaded and validated again.`,
        ),
      { title: text('安装写作 Skill', 'Install writing skill') },
    )
    if (!confirmed) return
    setBusy(true)
    setError(null)
    try {
      const result = current.source === 'local'
        ? await ipc.invoke('skills:install-local', current.inspection.filePath)
        : await ipc.invoke('skills:install-github', current.inspection.sourceUrl)
      if (!result.success) throw new Error(result.error || text('Skill 安装失败', 'Skill installation failed'))
      await reload()
      setPending(null)
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
            {text('添加写作 Skill', 'Add a writing skill')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            {text('仅支持自包含的提示词型 SKILL.md。脚本、hook、相对引用、子代理和工具执行要求不会被安装。检查栏可填 GitHub 地址，也可填本地 SKILL.md 路径 —— 两条路走完全相同的内容检查。', 'Only self-contained prompt SKILL.md files are supported. Scripts, hooks, relative references, subagents, and tool requirements are not installed. The source field accepts a GitHub URL or a local SKILL.md path; both paths run identical content checks.')}
          </p>
        </div>
        <div className="flex gap-2">
          {/* 先生：去掉链接图标 —— 它压在框体上像块污渍，输入框也不需要它 */}
          <div className="relative flex-1">
            <Input
              value={sourceUrl}
              onChange={event => setSourceUrl(event.target.value)}
              placeholder={text('https://github.com/owner/repository 或本地 SKILL.md 路径', 'https://github.com/owner/repository or a local SKILL.md path')}
              aria-label={text('GitHub Skill 地址', 'GitHub skill URL')}
            />
          </div>
          <Button variant="outline" onClick={inspectSource} disabled={busy || !sourceUrl.trim()}>
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
            {text('只读检查', 'Inspect')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={pickLocalSource} disabled={busy}>
            <FolderOpen size={13} />
            {text('从本地选择 SKILL.md', 'Choose a local SKILL.md')}
          </Button>
          <span className="text-xs leading-5 text-[var(--color-text-muted)]">
            {text('选中的路径会填到上面的检查栏，再点「只读检查」；导入时会重新读取该文件并复核校验值。', 'The chosen path fills the source field above — then press Inspect. The file is re-read and its checksum re-verified on import.')}
          </span>
        </div>
        {pending && (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3">
            <div className="flex items-start gap-3">
              {pending.inspection.compatible
                ? <ShieldCheck size={17} className="mt-0.5 shrink-0 text-[var(--color-success-text)]" />
                : <AlertTriangle size={17} className="mt-0.5 shrink-0 text-[var(--color-warning-text)]" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--color-text)]">
                  {pending.inspection.metadata.displayName ?? pending.inspection.metadata.name}
                </div>
                <p className="mt-0.5 text-xs leading-5 text-[var(--color-text-muted)]">{pending.inspection.metadata.description}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-secondary)]">
                  <span>{text('建议阶段', 'Suggested stage')}: {stageCopy(text, pending.inspection.suggestedStage)}</span>
                  <span>{text('语言', 'Language')}: {pending.inspection.metadata.language}</span>
                  <span>{text('大小', 'Size')}: {formatBytes(pending.inspection.utf8Bytes)}</span>
                  {pending.source === 'local' && (
                    <span>{text('来源文件', 'Source file')}: {pending.inspection.fileName}</span>
                  )}
                </div>
                {pending.source === 'local' && pending.inspection.identifierGenerated && (
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                    {text(
                      `技能标识符：${pending.inspection.skillId}（原名「${pending.inspection.declaredName}」不能用作标识符，已自动生成；界面与技能库仍显示原名，源文件不会被改动）`,
                      `Skill identifier: ${pending.inspection.skillId} (generated automatically because “${pending.inspection.declaredName}” is not a usable identifier; the display name is kept and your source file is never modified)`,
                    )}
                  </p>
                )}
                {!pending.inspection.compatible && (
                  <p role="alert" className="mt-2 text-xs text-[var(--color-warning-text)]">
                    {pending.inspection.reasons.map((reason) => {
                      const copy = REASON_COPY[reason]
                      return copy ? text(copy[0], copy[1]) : reason
                    }).join('；')}
                  </p>
                )}
              </div>
              <Button onClick={installPending} disabled={busy || !pending.inspection.compatible}>
                <Download size={13} />
                {pending.source === 'local'
                  ? text('确认导入', 'Confirm import')
                  : text('确认安装', 'Confirm install')}
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
              ? text('每个阶段最多启用一个 Skill；每一栏只列本阶段适配的 Skill，工作流启动时会冻结当次内容。', 'Each stage uses at most one skill, and each field lists only the skills suited to that stage; the content is frozen when the workflow starts.')
              : text('请先打开项目再绑定 Skill。', 'Open a project to bind skills.')}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {WRITING_SKILL_STAGES.map(stage => {
            /**
             * 每一栏只列**本阶段**的 Skill。
             *
             * 先生定的规矩：审稿就只能加载出审稿的 Skill，润色只出现在修稿那边 ——
             * 阶段对了才有用，混着列只会让人选错（而且选错确实白费：审稿的输出合同
             * 会压过写作方法类指导）。
             *
             * 例外：**已经绑着的那个务必保留**。它多半是早先绑错的，若因此从列表里消失，
             * 下拉会显示「不启用」而绑定其实还在 —— 作者既看不见也改不掉。留在这里正好改掉。
             */
            const boundSkillId = bindings[stage]
            const options = compatibleSkills.filter(skill => (
              skill.writingSkill.suggestedStage === stage || skill.skillId === boundSkillId
            ))
            return (
              <label key={stage} className="space-y-1 text-xs text-[var(--color-text-secondary)]">
                <span>{stageCopy(text, stage)}</span>
                <NativeSelect
                  value={boundSkillId ?? ''}
                  onChange={event => updateBinding(stage, event.target.value)}
                  disabled={busy || !projectSession}
                  aria-label={text(`${STAGE_COPY[stage][0]} Skill`, `${STAGE_COPY[stage][1]} skill`)}
                >
                  <option value="">{text('不启用', 'Disabled')}</option>
                  {options.map(skill => (
                    <option key={skill.skillId} value={skill.skillId}>{localizedSkillLabel(skill, text)}</option>
                  ))}
                </NativeSelect>
              </label>
            )
          })}
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
