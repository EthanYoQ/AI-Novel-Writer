/**
 * 档案铭牌 · 关系缩略网的几何布局（纯函数，无 DOM）。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────────
 * 「把一位角色的关系画成一张 168×66 的小网」这件事，难点不在 SVG 语法，
 * 而在**几何**：中心放哪、n 个端点怎么排才不挤、1 个端点和 6 个端点都不能难看。
 * 几何算错了肉眼一看就知道（点叠在一起、线挤成一把扇子），
 * 所以把它抽成纯函数，让契约测试能直接验「不重叠、不越界、对称」。
 *
 * ── 版面意图 ────────────────────────────────────────────────────────────────
 * 中心节点靠左（它是「这一位」），端点在右侧铺开成一列微弧 ——
 * 弧线比直线更像「网」，也比随机散布更可控。x 随 |t-0.5| 向外扩，
 * 于是中间点最靠右、上下两点稍收回，形成一条浅浅的弧。
 */
export interface PlatePoint {
  x: number
  y: number
}

export interface RelationshipPlateLayout {
  center: PlatePoint
  nodes: PlatePoint[]
}

/** 缩略网里最多画几个端点；再多就靠「+N」在外面说，不挤进图里。 */
export const RELATION_NET_MAX_NODES = 6

/**
 * 算出一张缩略网的落点。
 *
 * @param count 要画的端点数（调用方已按 RELATION_NET_MAX_NODES 截断）
 * @param width 画布宽（与 SVG 的 viewBox 一致）
 * @param height 画布高
 */
export function relationshipPlateLayout(
  count: number,
  width: number,
  height: number,
): RelationshipPlateLayout {
  const safeCount = Math.max(0, Math.floor(count))
  const center: PlatePoint = { x: 22, y: round(height / 2) }

  // 端点可用的竖向区间：上下各留 12px，端点方块 6px 才不会被画布切掉
  const top = 12
  const bottom = height - 12

  const nodes: PlatePoint[] = []
  for (let index = 0; index < safeCount; index += 1) {
    // n=1 → 0.5（正中间）；n>1 → 0…1 均匀
    const t = safeCount === 1 ? 0.5 : index / (safeCount - 1)
    const y = round(top + t * (bottom - top))
    // 中点最靠右，两端稍收回：一条浅弧，比直线更像网
    const arc = Math.abs(t - 0.5) * 2 // 0（中）… 1（两端）
    const x = round(width - 20 - arc * 26)
    nodes.push({ x, y })
  }

  return { center, nodes }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 从角色卡的 `relationships` 字段读出关系端点名。
 *
 * 这一列在库里既可能是结构化 JSON 数组，也可能是作者手写的自由文本
 * （导入的老档案、手工填的关系说明）。解析失败一律当「没有结构化关系」，
 * **绝不猜** —— 铭牌上画出来的每一个点都要有出处。
 */
export function relationshipTargets(raw: string | undefined | null): string[] {
  if (!raw) return []
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[')) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((edge) => {
        if (typeof edge !== 'object' || edge === null) return ''
        const target = (edge as { target?: unknown }).target
        return typeof target === 'string' ? target.trim() : ''
      })
      .filter((name) => name.length > 0)
  } catch {
    return []
  }
}
