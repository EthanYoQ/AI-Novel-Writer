/**
 * search_world_settings / read_world_setting — AI 取用世界观设定的唯一通道
 *
 * 先生定的路线：设定库**不做全量注入**。每章都把所有条目塞进提示词必然崩预算，
 * 所以改成「AI 需要时自己来搜」：
 *
 *   · search_world_settings：按名称 / 别名 / 关键词检索，返回**摘要级**结果
 *     （名称 + 分类 + 一句话摘要 + 是否还有详情），让 AI 先判断要不要深读；
 *   · read_world_setting：确实需要细节时，再按名称取**单条全文**。
 *
 * 两道硬约束：
 *   1. **只返回 confirmed 条目** —— pending 是 AI 或作者还没确认的候选，
 *      绝不能反过来喂给 AI，否则猜测会自我强化；
 *   2. 结果截断（条数 + 单条长度），无论库里有几百条，返回量都是常数级。
 */
import { buildAgentTool } from '../tool-registry'
import { useWorldSettingStore } from '../../../stores/world-setting-store'
import { getWorldSettingCategoryLabels, getWorldSettingImportanceLabels } from '../../../shared/world-setting'
import { sameProjectPathKey } from '../../../shared/project-session-context'
import { agentToolText, requireAgentProject } from './project-context'

/** 一次最多返回多少条：AI 拿去做判断用的清单，不需要全库。 */
const MAX_RESULTS = 20
/** 摘要级结果里每条摘要的截断长度。 */
const MAX_SUMMARY_CHARS = 160
/** read 工具返回全文时的截断长度。 */
const MAX_CONTENT_CHARS = 4000

function truncate(text: string, maxChars: number): string {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…（已截断）`
}

export const searchWorldSettingsTool = buildAgentTool({
  name: 'search_world_settings',
  description: '检索世界观设定库（势力、地理、规则、种族、物品、概念等条目）。需要确认某个设定的事实、规则或专有名词时用它；只返回摘要，需要全文再用 read_world_setting。',
  descriptionEn: 'Search the world-setting library (factions, geography, rules, races, items, concepts). Use it when you need to confirm a canonical fact, rule or proper noun; it returns summaries only — use read_world_setting for full detail.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '要查找的名称或关键词。留空则列出全部条目名（只到摘要级）。',
        descriptionEn: 'Name or keyword to look up. Leave empty to list every entry name at summary level.',
      },
      category: {
        type: 'string',
        description: '限定分类 key（可选）。例如 faction / geography / rule / item。',
        descriptionEn: 'Optional category key, e.g. faction, geography, rule, item.',
      },
    },
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const { projectSession } = requireAgentProject(context)
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)

    const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : ''
    const category = typeof args.category === 'string' ? args.category.trim() : ''

    const store = useWorldSettingStore.getState()
    // 归属闸门：store 里的条目必须属于当前项目。
    // 少了这一步，切项目后 AI 会把**上一部作品**的设定当成当前作品的既定事实
    // （store 只在侧栏或 @ 菜单挂载时加载，切项目并不会自动刷新）。
    if (store.dataProjectPath !== null
      && !sameProjectPathKey(store.dataProjectPath, projectSession.projectPath)) {
      return {
        success: true,
        content: text(
          '⚠️ 世界观设定库尚未加载到当前项目，本次没有可用的设定数据。',
          '⚠️ The world-setting library is not loaded for the current project, so no setting data is available.',
        ),
      }
    }
    const confirmed = store.entries.filter(entry => entry.status !== 'pending')

    const matched = confirmed.filter((entry) => {
      if (category && entry.category !== category) return false
      if (!query) return true
      const haystack = [entry.name, entry.summary, ...entry.aliases, ...entry.tags]
        .join(' ')
        .toLocaleLowerCase()
      return haystack.includes(query)
    })

    if (matched.length === 0) {
      return {
        success: true,
        content: confirmed.length === 0
          ? text(
              '⚠️ 世界观设定库目前没有任何已确认条目。',
              '⚠️ The world-setting library has no confirmed entries yet.',
            )
          : text(
              `未找到匹配「${query}」的设定条目（库中共 ${confirmed.length} 条已确认条目）。`,
              `No entries matched “${query}” (${confirmed.length} confirmed entries in total).`,
            ),
      }
    }

    const shown = matched.slice(0, MAX_RESULTS)
    const lines = shown.map((entry) => {
      const categoryLabels = getWorldSettingCategoryLabels(entry.category, store.categories)
      const importance = getWorldSettingImportanceLabels(entry.importance)
      const label = text(categoryLabels.zhCN, categoryLabels.enUS)
      const importanceLabel = text(importance.zhCN, importance.enUS)
      const aliases = entry.aliases.length > 0 ? `（别名：${entry.aliases.slice(0, 3).join('、')}）` : ''
      const summary = entry.summary ? truncate(entry.summary, MAX_SUMMARY_CHARS) : text('（无摘要）', '(no summary)')
      const hasDetail = entry.content.trim() ? text(' · 有详情', ' · has detail') : ''
      return `- 【${label}·${importanceLabel}】${entry.name}${aliases}\n  ${summary}${hasDetail}`
    })

    const header = text(
      `📚 世界观设定（命中 ${matched.length} 条${matched.length > shown.length ? `，只列前 ${shown.length} 条` : ''}）`,
      `📚 World settings (${matched.length} matched${matched.length > shown.length ? `, showing first ${shown.length}` : ''})`,
    )
    const footer = text(
      '\n\n需要某条的完整内容时，用 read_world_setting 传它的名称。',
      '\n\nUse read_world_setting with the entry name when you need the full text.',
    )

    return { success: true, content: `${header}\n\n${lines.join('\n')}${footer}` }
  },
})

export const readWorldSettingTool = buildAgentTool({
  name: 'read_world_setting',
  description: '读取某一条世界观设定的完整内容（含别名、标签与详情正文）。名称要写全，可先用 search_world_settings 找到确切名称。',
  descriptionEn: 'Read one world-setting entry in full, including aliases, tags and details. Pass the exact name; use search_world_settings first if unsure.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '条目名称（必填），例如「青云宗」。',
        descriptionEn: 'Entry name (required), e.g. "Azure Cloud Sect".',
      },
    },
    required: ['name'],
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const { projectSession } = requireAgentProject(context)
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)

    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) {
      return { success: false, content: '', error: text('缺少条目名称。', 'The entry name is required.') }
    }

    const store = useWorldSettingStore.getState()
    // 同 search_world_settings：读之前先确认 store 属于当前项目，防止跨项目事实泄漏。
    if (store.dataProjectPath !== null
      && !sameProjectPathKey(store.dataProjectPath, projectSession.projectPath)) {
      return {
        success: false,
        content: '',
        error: text(
          '世界观设定库尚未加载到当前项目，请先在侧栏打开「世界」面板后再试。',
          'The world-setting library is not loaded for the current project. Open the World panel in the sidebar and try again.',
        ),
      }
    }
    // 只认已确认条目；名称与别名都算命中。
    const entry = store.entries.find(candidate => (
      candidate.status !== 'pending'
      && (candidate.name === name || candidate.aliases.includes(name))
    ))

    if (!entry) {
      return {
        success: false,
        content: '',
        error: text(
          `没有找到已确认的设定条目「${name}」。可以用 search_world_settings 先查确切名称。`,
          `No confirmed entry named “${name}”. Use search_world_settings to find the exact name.`,
        ),
      }
    }

    const categoryLabels = getWorldSettingCategoryLabels(entry.category, store.categories)
    const importance = getWorldSettingImportanceLabels(entry.importance)
    const sections = [
      text(
        `📖 ${entry.name}（${categoryLabels.zhCN} · ${importance.zhCN}）`,
        `📖 ${entry.name} (${categoryLabels.enUS} · ${importance.enUS})`,
      ),
    ]
    if (entry.aliases.length > 0) {
      sections.push(text(`别名：${entry.aliases.join('、')}`, `Aliases: ${entry.aliases.join(', ')}`))
    }
    if (entry.summary) {
      sections.push(text(`摘要：${entry.summary}`, `Summary: ${entry.summary}`))
    }
    if (entry.tags.length > 0) {
      sections.push(text(`标签：${entry.tags.join('、')}`, `Tags: ${entry.tags.join(', ')}`))
    }
    sections.push('')
    sections.push(entry.content.trim() ? truncate(entry.content, MAX_CONTENT_CHARS) : text('（这条还没有详情正文）', '(no details yet)'))

    return { success: true, content: sections.join('\n') }
  },
})
