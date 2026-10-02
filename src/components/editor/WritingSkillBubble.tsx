/**
 * WritingSkillBubble — 在「AI 修稿确认 / 审稿确认」这类弹窗里就地挂载写作 Skill。
 *
 * 形态是**气泡 + 浮层下拉**，刻意不做内联展开：
 *   · 气泡常显答案（这次会带上哪个 Skill）—— 这类弹窗是「按下确认就开跑」的决策点，
 *     答案不该藏在点开之后；
 *   · 展开必须走浮层 —— 玩家可能装了几十个 Skill，内联展开会把弹窗整个撑爆；
 *     下拉列表在固定高度内滚动（.skill-menu-viewport），再多也不动版面。
 *   · 用 Radix Select 而不是原生 select：原生下拉在 Chromium 上是系统外观，
 *     与本项目的墨纸风格不搭；Radix 的浮层走 Portal、自动避让边缘、键盘与无障碍齐全，
 *     样式又完全可控。
 *
 * 为什么就地切换立刻生效：绑定写在项目的 `.vela/writing-skills.json`，而工作流
 * **启动时才冻结**当次内容（见 workflow-store 的 freezeWritingSkillsSnapshot）。
 * 弹窗阶段还没启动，所以这里改的就是这一次要用的那一份。
 */
import { useCallback, useEffect, useState } from 'react'
import * as Select from '@radix-ui/react-select'
import { Check, ChevronDown, Sparkles } from 'lucide-react'

import type { WritingSkillStage } from '../../shared/writing-skills'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { captureProjectSession } from '../project-session-gate'
import { skillRegistry, type LoadedSkill } from '../../services/agent/skill-registry'
import {
  loadWritingSkillBindings,
  saveWritingSkillBinding,
} from '../../services/agent/writing-skill-bindings'
import { localizedSkillLabel, stageCopy } from '../skill-copy'
import { toast } from '../ui/Toast'

/** Radix Select 的 item value 不能是空串，用这个哨兵值表示「不启用」。 */
const DISABLED_VALUE = '__none__'

interface Props {
  /** 本次操作对应的写作阶段：审稿 = review，修稿 = refinement。 */
  stage: WritingSkillStage
}

export default function WritingSkillBubble({ stage }: Props) {
  const { text } = useLocaleStore()
  const projectSessionKey = useProjectStore(state => state.currentProject?.sessionLease ?? '')
  const [skills, setSkills] = useState<LoadedSkill[]>([])
  const [boundSkillId, setBoundSkillId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    // 状态一律写在异步函数体内：在 effect 的同步体里直接 setState 会触发级联渲染。
    void (async () => {
      setLoading(true)
      setError('')
      try {
        const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
        if (!projectSession) {
          if (!cancelled) setLoading(false)
          return
        }
        await skillRegistry.loadAll()
        const bindings = await loadWritingSkillBindings(projectSession)
        if (cancelled) return
        setSkills(skillRegistry.listAll().filter(skill => skill.writingSkill.compatible))
        setBoundSkillId(bindings.bindings[stage] ?? null)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // 绑定是项目级的：换项目（租约变化）就要重新读一遍。
  }, [stage, projectSessionKey])

  const choose = useCallback(async (value: string) => {
    if (busy) return
    const skillId = value === DISABLED_VALUE ? null : value
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession) {
      setError(text('项目已切换，未保存本次选择。', 'The project changed, so this choice was not saved.'))
      return
    }
    setBusy(true)
    setError('')
    try {
      // 主进程按会话身份校验项目归属，这里不乐观假设。
      await saveWritingSkillBinding(projectSession, stage, skillId)
      setBoundSkillId(skillId)
      const picked = skillId ? skills.find(skill => skill.skillId === skillId) : null
      toast.success(picked
        ? text(
          `本次${stageCopy(text, stage)}将使用「${localizedSkillLabel(picked, text)}」`,
          `This ${stageCopy(text, stage)} run will use “${localizedSkillLabel(picked, text)}”`,
        )
        : text(
          `本次${stageCopy(text, stage)}不再挂载写作 Skill`,
          `No writing skill will be used for this ${stageCopy(text, stage)} run`,
        ))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, skills, stage, text])

  const bound = boundSkillId ? skills.find(skill => skill.skillId === boundSkillId) ?? null : null
  /**
   * 按来源计数，摆在菜单底部。
   *
   * 先生问过「自己装的 Skill 为什么读取不到」—— 与其让人猜，不如把读到的数量直接摊开：
   * 写着「用户 2」就说明读到了；写着「用户 0」而磁盘上明明有，那就是加载链路的问题，
   * 一眼可辨。（用户 Skill 由主进程从 VELA_HOME/skills 读取，读不到时是静默跳过的。）
   */
  const countBySource = (source: 'builtin' | 'user' | 'project') =>
    skills.filter(skill => skill.source === source).length

  /**
   * 只列**本阶段**的 Skill。
   *
   * 先生定的规矩：审稿只能列出审稿的 Skill，润色只出现在修稿那边 ——
   * 阶段对了才有用；混着列只会让人选错（而且选错确实白费：
   * 审稿的输出合同会压过写作方法类指导）。
   */
  const stageSkills = skills.filter(skill => skill.writingSkill.suggestedStage === stage)
  /**
   * 例外：**当前已绑定的那一个必须始终可见**。
   *
   * 早先可能绑过别的阶段的 Skill；若把它藏起来，界面会显示「不启用」而绑定其实还在 ——
   * 作者既看不见也改不掉，比"多显示一条"糟得多。它旁边会带上「建议用于 X」的提示，
   * 一看就知道该换掉。
   */
  const listedSkills = boundSkillId && !stageSkills.some(skill => skill.skillId === boundSkillId)
    ? [...stageSkills, ...skills.filter(skill => skill.skillId === boundSkillId)]
    : stageSkills
  const hiddenCount = skills.length - listedSkills.length

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
          {text('写作 Skill', 'Writing skill')}
        </span>
        {loading ? (
          <span className="skill-bubble" aria-busy="true">{text('读取中…', 'Loading…')}</span>
        ) : (
          <Select.Root
            value={boundSkillId ?? DISABLED_VALUE}
            onValueChange={value => { void choose(value) }}
            disabled={busy}
          >
            <Select.Trigger
              className={`skill-bubble ${bound ? 'on' : ''}`}
              aria-label={text('选择本次使用的写作 Skill', 'Choose the writing skill for this run')}
            >
              <Sparkles aria-hidden="true" />
              <Select.Value />
              <Select.Icon className="skill-bubble-caret">
                <ChevronDown aria-hidden="true" />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                className="skill-menu"
                position="popper"
                sideOffset={6}
                align="start"
                collisionPadding={12}
              >
                <Select.Viewport className="skill-menu-viewport">
                  <Select.Item value={DISABLED_VALUE} className="skill-option">
                    <span className="skill-option-mark">
                      <Select.ItemIndicator><Check aria-hidden="true" /></Select.ItemIndicator>
                    </span>
                    <Select.ItemText>{text('不启用', 'Disabled')}</Select.ItemText>
                  </Select.Item>
                  {listedSkills.map(skill => (
                    <Select.Item
                      key={skill.skillId}
                      value={skill.skillId}
                      className="skill-option"
                      title={skill.writingSkill.metadata.description}
                    >
                      <span className="skill-option-mark">
                        <Select.ItemIndicator><Check aria-hidden="true" /></Select.ItemIndicator>
                      </span>
                      {/* 名字交给 ItemText：气泡上显示的就是它。 */}
                      <Select.ItemText>{localizedSkillLabel(skill, text)}</Select.ItemText>
                      {/*
                        建议阶段与当前阶段不一致时标出来（例如在「AI 审稿」里选了润色类 Skill）。
                        标签放在 ItemText **之外** —— 放进 ItemText 会让气泡上也跟着显示。
                      */}
                      {skill.writingSkill.suggestedStage !== stage && (
                        <span className="skill-option-tag">
                          {text('建议用于', 'For')} {stageCopy(text, skill.writingSkill.suggestedStage)}
                        </span>
                      )}
                    </Select.Item>
                  ))}
                </Select.Viewport>
                <p className="skill-menu-hint">
                  {skills.length === 0
                    ? text(
                      '还没有可用的 Skill。可在「设置 → 写作 Skill」导入 SKILL.md；不装也不影响本次运行。',
                      'No skills available yet. Import a SKILL.md in Settings → Writing skills; this run works fine without one.',
                    )
                    : text(
                      `本阶段适配 ${stageSkills.length} 个；已读取 ${skills.length} 个（内置 ${countBySource('builtin')} · 用户 ${countBySource('user')}${countBySource('project') > 0 ? ` · 项目 ${countBySource('project')}` : ''}）${hiddenCount > 0 ? `，其余 ${hiddenCount} 个属于其它阶段、不在此列出` : ''}。改了立即生效 —— 本次运行开始前才冻结内容。`,
                      `${stageSkills.length} usable for this stage; ${skills.length} loaded (built-in ${countBySource('builtin')} · user ${countBySource('user')}${countBySource('project') > 0 ? ` · project ${countBySource('project')}` : ''})${hiddenCount > 0 ? `, ${hiddenCount} belong to other stages and are not listed here` : ''}. Changes apply immediately — the content is frozen only when this run starts.`,
                    )}
                </p>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        )}
        <span className="text-[0.65rem]" style={{ color: 'var(--color-text-muted)' }}>
          {text('会随本次提示词一起交给模型', 'Included with this run’s prompt')}
        </span>
      </div>

      {error && <p role="alert" className="mt-1 text-[0.7rem]" style={{ color: 'var(--color-error-text)' }}>{error}</p>}
    </div>
  )
}
