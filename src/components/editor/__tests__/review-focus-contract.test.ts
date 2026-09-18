/**
 * 审稿维度（重点检查维度）契约。
 *
 * 这张表里同一条维度有**两个名字**，用途完全不同：
 *   · label      —— 给作者看，措辞可以随产品口味调整（先生刚把前三条改成
 *                    「剧情的连贯性 / 剧情的合理性 / 角色前后状态」）；
 *   · promptLabel —— 给模型的维度名：既要参与审稿提示词的构造，又要把模型返回的
 *                    category 匹配回这张表（示例合同见 prompt-templates.ts）。
 *                    它一旦改动，模型返回的旧名字就匹配不上，审稿项会归错类。
 *
 * 所以这里同时钉住两件事：措辞是本轮定下的新版，而 promptLabel 一个字未动。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const editorSource = readFileSync('src/components/editor/DraftEditor.tsx', 'utf8')

describe('审稿维度契约', () => {
  it('作者看到的措辞是本轮定下的四条', () => {
    expect(editorSource).toContain("label: text('剧情的连贯性'")
    expect(editorSource).toContain("label: text('剧情的合理性'")
    expect(editorSource).toContain("label: text('角色前后状态'")
    expect(editorSource).toContain("label: text('前后章节串联'")
  })

  it('给模型的维度名保持原样，不跟着改文案', () => {
    for (const contractName of ['剧情连贯性', '剧情合理性', '角色状态', '前后章节串联']) {
      expect(editorSource).toContain(`promptLabel: '${contractName}'`)
    }
  })

  it('四个维度等宽排列（网格，而不是宽度不一的自动换行）', () => {
    // 先生：原先 flex-wrap 让四个标签参差换行，看着乱。
    expect(editorSource).toContain('grid grid-cols-2 gap-2')
    expect(editorSource).not.toContain('flex flex-wrap gap-2">\n                    {REVIEW_DIMS.map')
  })

  it('每一维都把自己的说明显示出来', () => {
    // desc 早就写在表里，但旧实现只渲染 label，白放着没用上。
    expect(editorSource).toContain('{d.desc}')
  })
})

describe('写作 Skill 气泡契约', () => {
  it('两个弹窗各自挂对了阶段：审稿 review、修稿 refinement', () => {
    // 挂错阶段不会报错，只会让作者绑的 Skill 静默不生效 —— 所以必须钉住。
    expect(editorSource).toContain('<WritingSkillBubble stage="review" />')
    expect(editorSource).toContain('<WritingSkillBubble stage="refinement" />')
  })

  it('气泡的选择真正写回项目绑定，而不是只改本地状态', () => {
    const bubbleSource = readFileSync('src/components/editor/WritingSkillBubble.tsx', 'utf8')
    // 读绑定 + 写绑定都在：只改本地状态的话，工作流启动时读到的还是旧绑定。
    expect(bubbleSource).toContain('loadWritingSkillBindings')
    expect(bubbleSource).toContain('saveWritingSkillBinding')
  })

  it('展开是浮层下拉，且列表在固定高度内滚动', () => {
    const bubbleSource = readFileSync('src/components/editor/WritingSkillBubble.tsx', 'utf8')
    // 先生：玩家可能装了几十个 Skill —— 内联展开会把弹窗撑爆，必须走浮层。
    expect(bubbleSource).toContain("from '@radix-ui/react-select'")
    expect(bubbleSource).toContain('Select.Portal')

    const shellCss = readFileSync('src/styles/redesign/shell.css', 'utf8')
    expect(shellCss).toContain('.skill-menu-viewport{max-height:236px;overflow-y:auto')
  })

  it('菜单摊开「读到了几个」与「建议用于哪个阶段」', () => {
    const bubbleSource = readFileSync('src/components/editor/WritingSkillBubble.tsx', 'utf8')
    // 先生问过「自己装的 Skill 为什么读取不到」，以及「在审稿里挂润色类有什么用」——
    // 前者靠来源计数自证，后者靠建议阶段提示，别再让作者猜。
    expect(bubbleSource).toContain('countBySource')
    expect(bubbleSource).toContain('suggestedStage')
  })

  it('只列本阶段的 Skill：审稿不出现润色类，反之亦然', () => {
    const bubbleSource = readFileSync('src/components/editor/WritingSkillBubble.tsx', 'utf8')
    // 先生定的规矩：审稿只能加载出审稿的 Skill，润色只出现在修稿那边。
    expect(bubbleSource).toContain("skill.writingSkill.suggestedStage === stage")
    expect(bubbleSource).toContain('listedSkills.map')
  })

  it('当前已绑定的那一个必须始终可见（否则显示「不启用」而实际仍绑着）', () => {
    const bubbleSource = readFileSync('src/components/editor/WritingSkillBubble.tsx', 'utf8')
    expect(bubbleSource).toContain('!stageSkills.some(skill => skill.skillId === boundSkillId)')
  })

  it('设置页的阶段绑定表也按阶段分家，同一个规矩两处一致', () => {
    const settingsSource = readFileSync('src/components/settings/SkillSettings.tsx', 'utf8')
    expect(settingsSource).toContain(
      'skill.writingSkill.suggestedStage === stage || skill.skillId === boundSkillId',
    )
  })
})
