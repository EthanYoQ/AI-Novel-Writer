import type { ReactNode } from 'react'
import { useLocaleStore } from '../../../stores/locale-store'
import {
  RELATION_NET_MAX_NODES,
  relationshipPlateLayout,
  relationshipTargets,
} from '../../../shared/relationship-plate'

/**
 * 人物档案 · 档案铭牌（v3「时尚杂志」）—— 页头的结构级重做
 *
 * ── 它取代了什么（先生 2026-09-16 的原话）──────────────────────────────────
 *   「连 CAST · 人物档案 / 布兰·史塔克 / 主角 · 最近更新：第 2 章
 *     这种标头都还是一直在沿用我们之前的设计风格和思路。都不敢自己做点 SVG 效果。」
 *
 * 旧的 .pagehead 是**三行文字**：小字眉标 → 大字标题 → 小字说明。
 * 那是「标题行」的思路，换字体换字号都改不掉它的骨架。
 * 这一版换了思路：**把信息画出来，而不是写出来。**
 *
 *   · 栏目徽记（自绘 SVG）   三个方点 + 连线 —— 「人，与人与人」，本页的栏目标记
 *   · 关系缩略网（自绘 SVG） 这位角色与书里谁相连，一眼可数；
 *                            尚未建档的端点画成虚线圈（缺档是事实，就该看得见）
 *   · 章号块（期刊化）       「最近更新 第 2 章」→ CH / 02 的期刊页码式排法
 *   · 方形头像              印刷品是方的 —— 与全站的方形印签同一套语言
 * 时间轴、关系数、缺档数都是**算出来的**，不是编的；没有数据就画空态。
 *
 * ── 配色 ────────────────────────────────────────────────────────────────────
 * 强调色一律取 `var(--mag-sec)`：那是**当前栏目色**，由 ShellV2 挂在编辑区上的
 * `data-sec` 决定。于是人物栏目标头是赭金、伏笔栏目标头是藕紫 ——
 * 标头的颜色与它背后的版面底色、左缘色带、书脊那一格，永远是同一个值。
 */
export interface CharacterProfilePlateProps {
  name: string
  /** 已本地化的角色定位（主角 / 反派 / 配角 / 龙套） */
  roleName: string
  roleKind: string
  /** 该角色状态更新到第几章；0 = 尚未开始 */
  updatedAtChapter: number
  /** 角色卡的 relationships 原始字段（可能是 JSON，也可能是手写文本） */
  relationships: string
  /** 全书已建档的角色名 —— 用来判断关系端点是否已有档案 */
  rosterNames: readonly string[]
  avatarUrl: string | null
  avatarInitial: string
  avatarBusy: boolean
  /** 只有编辑态才给换头像的入口 */
  canChooseAvatar: boolean
  onChooseAvatar: () => void
  /** 头像处理失败等提示 */
  notice?: ReactNode
  /** 右上角操作组 */
  actions?: ReactNode
}

export default function CharacterProfilePlate({
  name,
  roleName,
  roleKind,
  updatedAtChapter,
  relationships,
  rosterNames,
  avatarUrl,
  avatarInitial,
  avatarBusy,
  canChooseAvatar,
  onChooseAvatar,
  notice,
  actions,
}: CharacterProfilePlateProps) {
  const text = useLocaleStore((s) => s.text)

  const targets = relationshipTargets(relationships)
  const roster = new Set(rosterNames)
  const missing = targets.filter((target) => !roster.has(target)).length
  const shown = targets.slice(0, RELATION_NET_MAX_NODES)
  const hidden = targets.length - shown.length
  const { center, nodes } = relationshipPlateLayout(shown.length, NET_WIDTH, NET_HEIGHT)

  /** 「CH.02」用零填充的两位；0 表示这位角色还没进过正文 —— 如实写「未入正文」，不编数字 */
  const chapterLabel = updatedAtChapter > 0 ? String(updatedAtChapter).padStart(2, '0') : '—'
  const chapterUnit = updatedAtChapter > 0 ? text('章', 'CH') : text('未入正文', 'NOT YET')

  return (
    <div className="mag-plate">
      {/* 竖排栏目名：与书脊上的栏目名同一套排法，把这一页钉在「人物」这一栏上 */}
      <span className="mp-spine">CAST</span>

      <div className="mp-main">
        <div className="mp-row">
          <span className="mp-sigil" aria-hidden="true">
            <Sigil />
          </span>

          {/*
            肖像框（v3）—— 取代 demo 的 75px 圆头像。
            先生：「你把我的角色头像那弄没了？…你可以设置一个符合杂志感觉的新头像，
            设置弄新的头像交互谱。但不能把我本来的功能给阉割掉了。」
            所以：尺寸给足（96px）、印刷品是方的（直角 + 墨线外框）、
            换头像的入口**必须看得见**（悬停出整块栏目色覆盖层 + 图标 + 字样 + 角标），
            编辑态才可点、非编辑态只读 —— 与原来的权限规则一字不差。
          */}
          <span className="mp-portrait">
            {avatarUrl
              ? <img src={avatarUrl} alt="" />
              : <span className="mp-portrait-initial">{avatarInitial}</span>}
            {canChooseAvatar && (
              <button
                type="button"
                className="mp-portrait-hit"
                title={text('更换头像（保存档案后生效）', 'Change avatar (takes effect when you save)')}
                aria-label={text('更换头像', 'Change avatar')}
                aria-busy={avatarBusy}
                disabled={avatarBusy}
                onClick={onChooseAvatar}
              >
                <PortraitSwapIcon />
                <span className="mp-portrait-label">
                  {avatarBusy ? text('处理中', 'WORKING') : text('更换头像', 'CHANGE')}
                </span>
              </button>
            )}
            {/* 角标：杂志图片的印记，也是「这块可以点」的静默提示（悬停时让位给覆盖层） */}
            <span className="mp-portrait-corner" aria-hidden="true" />
          </span>

          <div className="mp-titles">
            <div className="mp-kicker">
              {text('CAST · 人物档案', 'CAST · CHARACTER PROFILE')}
            </div>
            <h1 className="mp-name">{name || text('未命名', 'Untitled')}</h1>
          </div>

          {/* 章号块：期刊页码的排法，「主角 · 最近更新：第 2 章」那条文字串就收在这里 */}
          <div className="mp-chapter">
            <span className="mp-chapter-label">
              {text('最近更新', 'UPDATED AT')}
            </span>
            <span className="mp-chapter-no">{chapterLabel}</span>
            <span className="mp-chapter-unit">{chapterUnit}</span>
          </div>
        </div>

        <div className="mp-data">
          {/* 关系缩略网：这一位与书里谁相连，一眼可数 */}
          <figure className="mp-net">
            <svg
              width={NET_WIDTH}
              height={NET_HEIGHT}
              viewBox={`0 0 ${NET_WIDTH} ${NET_HEIGHT}`}
              role="img"
              aria-label={text(
                targets.length > 0 ? `关系缩略图，共 ${targets.length} 条关系` : '关系缩略图，暂无关系',
                targets.length > 0 ? `Relation map with ${targets.length} links` : 'Relation map, no links yet',
              )}
            >
              {shown.map((target, index) => (
                <line
                  key={`link-${target}-${index}`}
                  className="mp-net-link"
                  x1={center.x}
                  y1={center.y}
                  x2={nodes[index].x}
                  y2={nodes[index].y}
                />
              ))}
              {nodes.map((node, index) => (
                <rect
                  key={`node-${shown[index]}-${index}`}
                  className={roster.has(shown[index]) ? 'mp-net-node' : 'mp-net-node is-missing'}
                  x={node.x - NODE / 2}
                  y={node.y - NODE / 2}
                  width={NODE}
                  height={NODE}
                >
                  <title>
                    {roster.has(shown[index])
                      ? shown[index]
                      : text(`${shown[index]}（尚未建档）`, `${shown[index]} (no profile yet)`)}
                  </title>
                </rect>
              ))}
              <rect
                className="mp-net-center"
                x={center.x - CENTER / 2}
                y={center.y - CENTER / 2}
                width={CENTER}
                height={CENTER}
              />
            </svg>
            <figcaption className="mp-net-caption">
              {targets.length > 0
                ? text(`关系 ${targets.length} 条`, `${targets.length} links`)
                : text('暂无关系记录', 'No links recorded')}
              {missing > 0 && <b>· {text(`${missing} 位未建档`, `${missing} unregistered`)}</b>}
              {hidden > 0 && <b>· {text(`另有 ${hidden} 条`, `${hidden} more`)}</b>}
            </figcaption>
          </figure>

          <div className="mp-facts">
            <span className="mp-fact-role">{roleName}</span>
            <span className="mp-fact-kind">{kindLabel(roleKind, text)}</span>
          </div>
        </div>
      </div>

      {actions && <div className="mp-actions">{actions}</div>}

      {notice}
    </div>
  )
}

/** 缩略网的画布与节点尺寸（与 relationshipPlateLayout 的调用参数一致） */
const NET_WIDTH = 168
const NET_HEIGHT = 66
const NODE = 6
const CENTER = 9

/** 换头像的图标（自绘）：两个错开的方框 —— 后面那个是原来的照片，前面这个是换上的。 */
function PortraitSwapIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect className="mp-swap-back" x="1.5" y="4.5" width="12" height="12" />
      <rect className="mp-swap-front" x="4.5" y="1.5" width="12" height="12" />
    </svg>
  )
}

/** 栏目徽记：三个方点 + 连线 —— 「人，与人与人」。 */
function Sigil() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <line className="mp-sigil-link" x1="13" y1="6" x2="5.5" y2="19.5" />
      <line className="mp-sigil-link" x1="13" y1="6" x2="20.5" y2="19.5" />
      <line className="mp-sigil-link" x1="5.5" y1="19.5" x2="20.5" y2="19.5" />
      <rect className="mp-sigil-node is-lead" x="10" y="3" width="6" height="6" />
      <rect className="mp-sigil-node" x="2.5" y="16.5" width="6" height="6" />
      <rect className="mp-sigil-node" x="17.5" y="16.5" width="6" height="6" />
    </svg>
  )
}

/** 角色定位的英文对照 —— 中文角色名已由调用方本地化，这里只补一格小字。 */
function kindLabel(kind: string, text: (zh: string, en: string) => string): string {
  if (kind === 'protagonist') return text('视角人物', 'POV')
  if (kind === 'antagonist') return text('对立面', 'OPPOSITION')
  if (kind === 'supporting') return text('配角', 'SUPPORTING')
  return text('次要', 'MINOR')
}
