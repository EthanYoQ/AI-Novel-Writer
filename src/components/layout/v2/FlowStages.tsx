import { Check } from 'lucide-react'

import { useLocaleStore } from '../../../stores/locale-store'
import {
  CREATION_STAGE_ORDER,
  STAGE_HINT,
  STAGE_LABEL,
  type CreationStage,
} from './creation-stages'

/**
 * 「墨纸书斋」的六道工序条。
 *
 * 两种数据来源，优先级不同：
 *  · `stages` —— 由**项目真实数据**派生的完成度（先生要的「永远显示选中的小说、
 *    最新章节走到哪一步」）。配置有没有填、架构有没有生成、蓝图规划了几章、
 *    草稿/审稿/定稿各有多少章，都能算出来。
 *  · `current` —— 工作流的**实时运行**状态（useCreationStage）。没有任务在跑时
 *    它给不出任何进度，整条只能置灰。
 *
 * 所以给了 `stages` 就用它：对写作者来说「这本书走到哪了」比「此刻有没有任务在跑」有用得多。
 *
 * 每一段都带 `title`，写着这道工序的作用（先生：「也需要把作用显示出来」）。
 */
export interface FlowStagesProps {
  /** 运行中的工序；null 表示当前没有任务在跑 */
  current?: CreationStage | null
  /** 由项目真实数据派生的完成度（useProjectOverview.stages） */
  stages?: ReadonlyArray<{ stage: CreationStage; done: boolean; now: boolean }> | null
}

export default function FlowStages({ current = null, stages = null }: FlowStagesProps) {
  const text = useLocaleStore((s) => s.text)
  const currentIndex = current ? CREATION_STAGE_ORDER.indexOf(current) : -1
  const derived = stages && stages.length > 0 ? stages : null

  const stateOf = (stage: CreationStage, index: number) => {
    const item = derived?.find((entry) => entry.stage === stage)
    if (item) return { done: item.done, now: item.now }
    return {
      done: currentIndex >= 0 && index < currentIndex,
      now: index === currentIndex,
    }
  }

  return (
    <nav className="flow" aria-label={text('创作进度', 'Creation progress')}>
      {CREATION_STAGE_ORDER.map((stage, index) => {
        const label = text(STAGE_LABEL[stage].zh, STAGE_LABEL[stage].en)
        const hint = text(STAGE_HINT[stage].zh, STAGE_HINT[stage].en)
        const { done, now } = stateOf(stage, index)
        const state = done
          ? text(' · 已完成', ' · done')
          : now
            ? text(' · 进行中', ' · in progress')
            : ''
        const prevDone = index > 0
          ? stateOf(CREATION_STAGE_ORDER[index - 1], index - 1).done
          : false

        return (
          <span key={stage} style={{ display: 'contents' }}>
            {index > 0 && <span className={`flink${prevDone ? ' done' : ''}`} />}
            <span
              className={`fnode${done ? ' done' : now ? ' now' : ''}`}
              title={`${hint}${state}`}
            >
              <span className="fdot">{done && <Check size={8} strokeWidth={3.4} />}</span>
              <span className="flb">{label}</span>
            </span>
          </span>
        )
      })}
    </nav>
  )
}
