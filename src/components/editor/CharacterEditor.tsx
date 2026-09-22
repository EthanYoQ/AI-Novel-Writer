import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Camera, Network, PenLine, Save, Trash2, Users, X } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { registerEditorExitSaveHandler } from '../../stores/editor-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'
import {
  useCharacterStore,
  EMPTY_STATE,
  type CharacterCard,
  type CharacterCurrentState,
} from '../../stores/character-store'
import { EmptyState as BaseEmptyState } from '../ui/EmptyState'
import { openBuiltinEditor } from '../panels/sidebar/sidebar-file-openers'
import { useLocaleStore } from '../../stores/locale-store'
import { CHARACTER_ROLES, getCharacterRoleLabels } from '../../shared/character-role'
import {
  formatRelationshipsForEditor,
  relationshipStorageFromEditor,
  unregisteredRelationshipTargets,
} from '../../shared/relationship-presentation'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { useCharacterAvatar } from './use-character-avatar'
import { useUiVersionStore, isMagazine } from '../../stores/ui-version-store'
import CharacterProfilePlate from './magazine/CharacterProfilePlate'

/* ============================================================================
 * 人物档案页排版 = 设计 demo 的 DOM 结构与类名（AI小说家-Demo/
 * novel-app-demo-relation-avatars.html viewCharacter() 3443–3490 行）。
 * 皮肤只在 html[data-ui='v2'] 下生效（src/styles/redesign/shell.css）。
 * ========================================================================== */

/** demo 3445 行原本是 920px 档案栏；先生要求正文栏内各子菜单宽度统一，
 *  故与「剧情线」计划清单对齐成 max-w-5xl（1024px）。 */
const ARCHIVE_SCROLL_STYLE: CSSProperties = { height: '100%', overflowY: 'auto' }
const ARCHIVE_PAGE_STYLE: CSSProperties = { maxWidth: 1024, margin: '0 auto', padding: '0 32px 46px' }
/**
 * 先生（头像行规格）：头像框在原来的 58px 上放大 30%（58 × 1.3 ≈ 75px），
 * 整行「头像框 + 角色名 + 灰色注释」再往右移 20px。
 * 头像框容器尺寸由 CSS 的 .character-avatar-wrap 同步（shell.css）。
 */
const AVATAR_SIZE = 75
const AVATAR_ROW_INDENT = 20
/** demo 3451 行：头像行（头像 + 姓名 + 定位徽标）。 */
const AVATAR_ROW_STYLE: CSSProperties = {
  display: 'flex',
  gap: 14,
  alignItems: 'center',
  padding: '5px 0 17px',
  marginBottom: 2,
  marginLeft: AVATAR_ROW_INDENT,
}
/** demo 3479 行查看态摘要网格与编辑态字段网格的间距（3463 / 3467 行）。 */
const PROFILE_GRID_STYLE: CSSProperties = { marginBottom: 13 }
const STATE_GRID_STYLE: CSSProperties = { marginBottom: 10 }
/** demo 3457 行编辑条内的说明字。 */
const EDITBAR_HINT_STYLE: CSSProperties = { fontSize: 10, color: 'var(--muted)', marginRight: 'auto', alignSelf: 'center' }
/** demo 3454 行头像行右侧的姓名与定位说明。 */
const AVATAR_NAME_STYLE: CSSProperties = { fontFamily: 'var(--serif)', fontSize: 18 }
const AVATAR_ROLE_STYLE: CSSProperties = { fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }
const AVATAR_BLOCK_STYLE: CSSProperties = { flex: 1, minWidth: 0 }
/** demo 1651 行 avatarMarkup() 的字符头像分支（无自定义头像时的回落形态）。 */
const AVATAR_INITIAL_STYLE: CSSProperties = {
  width: AVATAR_SIZE,
  height: AVATAR_SIZE,
  borderRadius: '50%',
  background: 'var(--seal)',
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--serif)',
  fontSize: 34,
  flex: 'none',
}
/** demo 1651 行 avatarMarkup() 的图片分支：圆形裁切、铺满头像框。 */
const AVATAR_IMAGE_STYLE: CSSProperties = {
  width: AVATAR_SIZE,
  height: AVATAR_SIZE,
  borderRadius: '50%',
  objectFit: 'cover',
  display: 'block',
}
/** 头像读取/保存失败的轻量提示（demo 用 toast，产品此处就地说明）。 */
const AVATAR_NOTICE_STYLE: CSSProperties = { fontSize: 10.5, color: 'var(--seal)', margin: '-9px 0 11px' }
/** 当前状态档案尚未由 AI 写入时的产品内提示（demo 无对应结构）。 */
const STATE_HINT_STYLE: CSSProperties = { marginTop: 16, padding: '10px 12px', fontSize: 11, color: 'var(--muted)', background: 'var(--paper2)' }

/** 上游 1.1.0：状态来源标注（作者输入 / 定稿派生 / 来源未知）的小字样式，挂在字段标签后。 */
const FIELD_NOTE_STYLE: CSSProperties = {
  marginLeft: 6,
  fontStyle: 'normal',
  fontWeight: 400,
  fontSize: 10,
  color: 'var(--muted)',
}

/** demo 3402 行 miniField()：编辑态窄字段。 */
function MiniField({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <label className="archive-edit-field">
      <span>
        {label}
        {note ? <i style={FIELD_NOTE_STYLE}>{note}</i> : null}
      </span>
      {children}
    </label>
  )
}

/** demo 3405 行 bigField()：编辑态长文字段（textarea 造型取自 .archive-edit-field textarea）。 */
function BigField({
  label,
  value,
  placeholder,
  onChange,
  note,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  note?: string
}) {
  return (
    <label className="archive-edit-field archive-edit-big">
      <span>
        {label}
        {note ? <i style={FIELD_NOTE_STYLE}>{note}</i> : null}
      </span>
      <textarea value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
    </label>
  )
}

/** demo 3490 行 archiveText()：查看态长文分区，lead 走首字下沉排版。 */
function ArchiveSection({ label, value, lead = false, note }: { label: string; value: string; lead?: boolean; note?: string }) {
  return (
    <section className={lead ? 'archive-section lead' : 'archive-section'}>
      <h3>
        {label}
        {note ? <i style={FIELD_NOTE_STYLE}>{note}</i> : null}
      </h3>
      <p className={lead ? 'archive-lead' : undefined}>{value}</p>
    </section>
  )
}

/** demo 3480 行档案长文顺序：外貌描写 → 性格特征 → 背景故事 → 能力 / 技能 → 核心动机 → 关系网 → 成长轨迹。 */
const PROFILE_FIELDS_BEFORE_RELATIONSHIPS = [
  { key: 'appearance', zh: '外貌描写', en: 'Appearance', placeholderZh: '输入外貌描写...', placeholderEn: 'Describe appearance...' },
  { key: 'personality', zh: '性格特征', en: 'Personality', placeholderZh: '输入性格特征...', placeholderEn: 'Describe personality...' },
  { key: 'background', zh: '背景故事', en: 'Background', placeholderZh: '输入背景故事...', placeholderEn: 'Describe background...' },
  { key: 'abilities', zh: '能力/技能', en: 'Abilities / skills', placeholderZh: '输入能力/技能...', placeholderEn: 'Describe abilities or skills...' },
  { key: 'motivation', zh: '核心动机', en: 'Core motivation', placeholderZh: '输入核心动机...', placeholderEn: 'Describe core motivation...' },
] as const

/** 关系网之后的档案长文；备注是产品字段，demo 无对应分区，置于末位。 */
const PROFILE_FIELDS_AFTER_RELATIONSHIPS = [
  { key: 'arc', zh: '成长轨迹', en: 'Character arc', placeholderZh: '输入成长轨迹...', placeholderEn: 'Describe the character arc...' },
  { key: 'notes', zh: '备注', en: 'Notes', placeholderZh: '输入备注...', placeholderEn: 'Enter notes...' },
] as const

/** demo 3468–3471 / 3483 行：当前状态的四个窄字段。 */
const STATE_GRID_FIELDS = [
  { key: 'location', zh: '当前位置/阵营', en: 'Location / faction' },
  { key: 'powerLevel', zh: '修为境界/能力等级', en: 'Power or ability level' },
  { key: 'physicalState', zh: '身体状态（伤势/BUFF/外貌）', en: 'Physical state (injuries, effects, appearance)' },
  { key: 'mentalState', zh: '心理状态（愿望/恐惧/心态）', en: 'Mental state (goals, fears, mindset)' },
] as const

/** demo 3473 / 3484 行：当前状态的两个长文字段。 */
const STATE_TEXT_FIELDS = [
  { key: 'keyItems', zh: '关键道具/资源', en: 'Key items / resources' },
  { key: 'recentEvents', zh: '最近重要事件', en: 'Recent important events' },
] as const

/**
 * 编辑态快照：进入编辑态时的角色卡。点「取消」时按此原样还原（不写入档案），
 * 保存成功后丢弃快照回到阅览态（demo 3438 行 saveCharacterEdit 的 S.charEditing=false）。
 */
interface ArchiveEditSnapshot {
  /** 编辑会话标识：进入编辑态时分配；中途改名沿用同一会话，取消 / 保存即作废。 */
  sessionId: number
  /** 进入编辑态时的姓名；取消时据此把中途的改名还原。 */
  originalName: string
  /** 当前等效名（本组件内改名成功后同步），用于识别是否已切到别的角色。 */
  anchorName: string
  card: CharacterCard
}

/** 关系网输入框里尚未随档案保存的作者原文，以及它所属的编辑会话。 */
interface RelationshipDraft {
  sessionId: number
  text: string
}

/** 取消编辑时要还原的字段（姓名经 renameCharacter 单独还原，故不在其中）。 */
const ARCHIVE_RESTORE_KEYS = [
  'gender',
  'age',
  'role',
  'appearance',
  'personality',
  'background',
  'abilities',
  'motivation',
  'relationships',
  'arc',
  'notes',
  'currentState',
] as const

/**
 * 角色卡编辑器 — 纯编辑区域（角色列表已移至侧栏）
 * 从 character-store 读取选中角色，按 demo 的人物档案版面渲染。
 */
export default function CharacterEditor({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore(s => s.currentProject)
  const addLog = useWorkflowStore(s => s.addLog)
  const characters = useCharacterStore(s => s.characters)
  const dataProjectKey = useCharacterStore(s => s.dataProjectKey)
  const loadingProjectKey = useCharacterStore(s => s.loadingProjectKey)
  const lastError = useCharacterStore(s => s.lastError)
  const selectedName = useCharacterStore(s => s.selectedName)
  const identityBusy = useCharacterStore(s => s.identityBusy)
  const renameCharacter = useCharacterStore(s => s.renameCharacter)
  const addNamedCharacters = useCharacterStore(s => s.addNamedCharacters)
  const updateField = useCharacterStore(s => s.updateField)
  const deleteCharacter = useCharacterStore(s => s.deleteCharacter)
  const saveAll = useCharacterStore(s => s.saveAll)
  const [viewMode, setViewMode] = useState<'edit' | 'state'>('edit')
  // 对应 demo 的 S.charEditing（3446–3449 行「编辑档案 / 保存修改」按钮）。
  // 进入页面默认阅览态（demo 3443 行 viewCharacter 的 else 分支 → archive-view），
  // 点「编辑档案」才进编辑态；快照非空即表示正在编辑。
  const [editSnapshot, setEditSnapshot] = useState<ArchiveEditSnapshot | null>(null)
  const charEditing = editSnapshot !== null
  /** 编辑会话计数器：每次进入编辑态开一个新会话，让上一会话的关系网草稿作废。 */
  const editSessionCounter = useRef(0)
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  /**
   * 界面版本：v3「时尚杂志」的档案页头是**结构不同的一版**（见下方 magazine 分支）——
   * 不是给同一个 .pagehead 换字体换颜色，而是换成一块「档案铭牌」：
   * 自绘 SVG 栏目徽记 + 自绘 SVG 关系缩略网 + 期刊化章号块。
   * v2 墨纸书斋继续走原路径，逐像素不变。
   */
  const uiVersion = useUiVersionStore(s => s.uiVersion)
  const magazine = isMagazine(uiVersion)
  const roleLabel = (role: CharacterCard['role']) => {
    const { zhCN, enUS } = getCharacterRoleLabels(role)
    return text(zhCN, enUS)
  }
  const projectMatches = currentProject?.path === projectKey
  const dataReady = Boolean(
    projectMatches
    && dataProjectKey === projectKey
    && loadingProjectKey === null
    && lastError === null,
  )

  // 数据由 ProjectService 统一加载，组件只消费 store 数据

  /** 先生：自定义头像。数据就绪后才按当前角色读取；只在编辑档案时可改，
   *  改动先暂存在这里，等「保存修改」成功那一刻才随档案一起落库。 */
  const {
    avatarUrl,
    busy: avatarBusy,
    notice: avatarNotice,
    chooseAvatar,
    stageRemoval,
    commitStaged,
    discardStaged,
  } = useCharacterAvatar(dataReady ? selectedName : null, charEditing)

  /**
   * 关系网编辑草稿 + 它所属的编辑会话。
   *
   * 档案里存的是结构化关系边，输入框里显示的是「角色：关系」逐行文本，两者
   * 互为转换。可作者打字必然经过「刚敲完一行、正要换到下一行」这类中间态：
   * 此时若把文本立刻解析成结构、再把解析结果渲染回输入框，行尾那个换行会被
   * 转换吃掉 —— 回车看上去就是失灵，第二行永远写不出来。所以编辑态由本地
   * 草稿承接作者原文。
   *
   * 草稿只在「同一个编辑会话」内生效（会话由 editSnapshot.sessionId 标识）：
   * 进入编辑态会开一个新会话，取消 / 保存 / 切换角色会丢掉快照，旧草稿因此
   * 自动失效 —— 不需要任何 effect 回写状态。改名沿用同一会话，草稿照常保留。
   */
  const [relationshipDraft, setRelationshipDraft] = useState<RelationshipDraft | null>(null)
  const relationshipDraftText = relationshipDraft && relationshipDraft.sessionId === editSnapshot?.sessionId
    ? relationshipDraft.text
    : null

  const selectedCard = dataReady
    ? characters.find((c) => c.name === selectedName) || null
    : null
  const relationshipEditorText = selectedCard
    ? formatRelationshipsForEditor(selectedCard.relationships, { locale })
    : ''
  const currentState: CharacterCurrentState = selectedCard?.currentState ?? EMPTY_STATE
  const updatedAtChapter = selectedCard?.currentState?.updatedAtChapter ?? 0
  // 关系文本里写了关系、但那个角色还没进名单：这些名字可以直接一键建卡，
  // 建完之后对应的关系会自动升级成结构化边（图谱与写稿注入都能用上）。
  const relationshipTextForHints = relationshipDraftText ?? relationshipEditorText
  const unregisteredTargets = useMemo(
    () => (selectedCard && dataReady
      ? unregisteredRelationshipTargets(relationshipTextForHints, {
        knownNames: characters.map(character => character.name),
        selfName: selectedCard.name,
      })
      : []),
    [characters, dataReady, relationshipTextForHints, selectedCard],
  )

  const handleDelete = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!selectedCard || !projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const ok = await confirm(
      text(`确定要删除角色「${selectedCard.name || '未命名'}」吗？此操作不可撤销。`, `Delete character “${selectedCard.name || 'Untitled'}”? This cannot be undone.`),
      { title: text('删除角色', 'Delete character'), confirmText: text('删除', 'Delete'), danger: true }
    )
    if (!ok || !isProjectSessionCurrent(projectSession)) return
    const deleted = await deleteCharacter(selectedCard.name, projectKey)
    if (!isProjectSessionCurrent(projectSession)) return
    if (!deleted) {
      addLog(
        'error',
        text(
          '角色删除失败：项目可能已切换，请刷新后重试',
          'Could not delete the character. The project may have changed; refresh and try again.',
        ),
      )
    }
  }

  const handleSave = async (returnToArchive = false) => {
    if (!projectMatches) {
      const message = text('此标签属于另一个项目，无法保存。', 'This tab belongs to another project.')
      addLog('error', message)
      toast.error(message)
      return
    }
    // 与编辑（character-store.updateField）用同一套判据：直接读 currentProject 的会话，
    // 不再依赖模块级「活动会话」。二者一旦失配，就会出现「能编辑、点保存却没反应」的
    // 无声失败——这里同时把静默 return 全部换成明确错误，失败不再无迹可循。
    const projectSession = projectSessionContextFromProject(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      const message = text('项目会话已失效，无法保存。请重新打开人物档案后再试。', 'Project session expired. Reopen the character tab and try again.')
      addLog('error', message)
      toast.error(message)
      return
    }
    try {
      await saveAll(projectKey)
      // 先生：头像与角色卡一起生效 —— 档案保存成功之后才提交暂存的头像改动。
      await commitStaged()
      addLog('info', text(`已保存 ${characters.length} 个角色卡`, `Saved ${characters.length} character cards`))
      // demo 3438 行：保存成功后退出编辑态，回到档案阅览排版。
      if (returnToArchive) setEditSnapshot(null)
    } catch (error) {
      const message = text(`角色卡保存失败：${error}`, 'Could not save character cards.')
      addLog('error', message)
      toast.error(message)
    }
  }

  const exitSaveRef = useRef(handleSave)
  useEffect(() => {
    exitSaveRef.current = handleSave
  })
  useEffect(() => {
    registerEditorExitSaveHandler({
      type: 'character',
      projectKey,
      save: () => exitSaveRef.current(),
    })
  }, [projectKey])

  // 切换到别的角色（侧栏选中、名单变化）时退出编辑态并丢弃快照，避免把上一位角色
  // 的编辑内容还原到另一位身上。本组件内的改名会同步 anchorName，故不会误判。
  //
  // 为什么不能改成派生值（editSnapshot && anchorName === selectedName）：派生只是
  // 「暂时当作没有编辑态」，从别的角色切回来时会把已经结束的编辑会话连同关系草稿
  // 一起复活；这里是真的结束会话，与设计意图一致。
  useEffect(() => {
    if (!editSnapshot) return
    if (selectedName === editSnapshot.anchorName) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 结束一次已失效的角色档案编辑会话（上面注释说明了为何不能用派生替代）
    setEditSnapshot(null)
  }, [editSnapshot, selectedName])

  /**
   * 「关系图谱」是一个独立标签页（对齐 demo 的 ensureTab({ id: 'relations' })）。
   *
   * 先生：图谱不该塞在人物档案里 —— 那样打开之后就回不去档案了。开成标签之后，
   * 档案标签原地不动，点一下就回来；切走再回来图谱也还在。
   * 固定 id 保证「同一页面只留一个标签」，反复点不会堆出第二个图谱页。
   */
  const openRelationshipGraph = () => {
    openBuiltinEditor(
      'relationship-graph',
      text('人物关系图谱', 'Character relationship graph'),
      'relationship-graph',
    )
  }

  const updateCurrentField = <K extends Exclude<keyof CharacterCard, 'name'>>(
    name: string,
    key: K,
    value: CharacterCard[K],
  ) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    updateField(name, key, value)
  }

  const renameCurrentCharacter = (name: string, nextName: string) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return false
    const renamed = renameCharacter(name, nextName)
    // 编辑态中的改名同时推进锚点，保持「当前编辑的还是同一个角色」。
    if (renamed) {
      setEditSnapshot(previous => (
        previous && previous.anchorName === name ? { ...previous, anchorName: nextName } : previous
      ))
    }
    return renamed
  }

  /** demo 3449 行「编辑档案」：进入编辑态并按当前角色卡留快照。 */
  const beginEditing = () => {
    if (!selectedCard) return
    editSessionCounter.current += 1
    setEditSnapshot({
      sessionId: editSessionCounter.current,
      originalName: selectedCard.name,
      anchorName: selectedCard.name,
      card: { ...selectedCard },
    })
  }

  /**
   * 编辑态的「取消」：回到阅览态且不写入档案 —— 把快照里的字段逐个还原到 store 草稿，
   * 中途的改名也一并还原。走的是与编辑同样的 draft 通路，不新增状态层。
   */
  const cancelEditing = () => {
    const snapshot = editSnapshot
    setEditSnapshot(null)
    // 先生：放弃编辑时头像改动一并丢弃 —— 磁盘与数据库始终停留在保存过的状态。
    discardStaged()
    if (!snapshot || !selectedCard) return
    const targetIndex = characters.findIndex(character => character.name === selectedCard.name)
    const nameTaken = characters.some((character, index) => (
      index !== targetIndex && character.name === snapshot.originalName
    ))
    const renamed = snapshot.originalName && snapshot.originalName !== selectedCard.name && !nameTaken
      ? renameCurrentCharacter(selectedCard.name, snapshot.originalName)
      : false
    const targetName = renamed ? snapshot.originalName : selectedCard.name
    ARCHIVE_RESTORE_KEYS.forEach(key => {
      updateCurrentField(targetName, key, snapshot.card[key])
    })
  }

  /** 上游 1.1.0：字段来源标注 —— 区分作者手填、模型从定稿正文提炼、以及旧项目的未知来源。 */
  const stateFieldNote = (
    key: (typeof STATE_GRID_FIELDS)[number]['key'] | (typeof STATE_TEXT_FIELDS)[number]['key'],
  ): string | undefined => {
    if (!selectedCard?.currentState) return undefined
    const kind = selectedCard.currentState.provenance?.[key]?.kind
    if (kind === 'author') return text('作者输入', 'Author input')
    if (kind === 'derived') return text('定稿派生', 'Derived from finalized prose')
    return text('来源未知', 'Unknown source')
  }

  const updateStateField = (
    key: (typeof STATE_GRID_FIELDS)[number]['key'] | (typeof STATE_TEXT_FIELDS)[number]['key'],
    value: string,
  ) => {
    if (!selectedCard) return
    const nextState: CharacterCurrentState = {
      ...(selectedCard.currentState ?? EMPTY_STATE),
      [key]: value,
      // 上游 1.1.0：作者手改的状态标为 author，避免后续写作把它当成模型提炼的定稿派生内容
      provenance: {
        ...selectedCard.currentState?.provenance,
        [key]: {
          kind: 'author',
          chapterNumber: selectedCard.currentState?.updatedAtChapter ?? 0,
        },
      },
    }
    updateCurrentField(selectedCard.name, 'currentState', nextState)
  }

  // ===== 渲染 =====

  /** 关系缩略网要知道「端点是否已建档」——用它决定画实心点还是虚线圈。 */
  const rosterNames = useMemo(() => characters.map((card) => card.name), [characters])

  if (!projectMatches) {
    return (
      <BaseEmptyState
        icon={<Users size={36} />}
        message={text('此标签属于另一个项目，请切回原项目后继续。', 'This tab belongs to another project. Switch back to continue.')}
        opacity={0.4}
      />
    )
  }

  const roleName = selectedCard ? roleLabel(selectedCard.role) : ''
  // demo 3446 行 ph-d：定位 + 最近更新章号。
  const headerDetail = !selectedCard
    ? text('未选择角色', 'No character selected')
    : updatedAtChapter > 0
      ? `${roleName} · ${text(`最近更新：第 ${updatedAtChapter} 章`, `Last updated: Chapter ${updatedAtChapter}`)}`
      : roleName
  // demo 3454 行头像行副标题：主角标注视角人物。
  const avatarSubtitle = !selectedCard
    ? ''
    : selectedCard.role === 'protagonist'
      ? text('视角主角 · 全书 POV', 'POV protagonist · whole book')
      : roleName
  // 产品数据模型没有头像字段，取姓名首字作 demo avatarMarkup() 的字符头像分支。
  const avatarInitial = selectedCard ? (selectedCard.name.trim().slice(0, 1) || '?') : '?'

  /**
   * 页头操作组。
   *
   * 抽出来是因为 v2 与 v3 的页头**版式不同、动作必须一模一样**：
   * v2 是 .pagehead 右侧的 .ph-a，v3 是档案铭牌右下角那一格。
   * 换版式不能顺手换功能 —— 抽成一份，两边都不可能漂移。
   */
  const headerActions = selectedCard ? (
    <>
      <button
        className="btn outline sm"
        type="button"
        onClick={() => setViewMode(viewMode === 'state' ? 'edit' : 'state')}
        title={viewMode === 'state' ? text('返回基础设定', 'Return to core profile') : text('查看当前进展/状态', 'View current state')}
      >
        {viewMode === 'state' ? text('基础档案', 'Core profile') : text('当前状态', 'Current state')}
      </button>
      <button
        className="btn outline sm"
        type="button"
        onClick={openRelationshipGraph}
        title={text('在独立标签页里查看全员关系网', 'Open the full relationship graph in its own tab')}
      >
        <Network size={11} /> {text('关系图谱', 'Relationship graph')}
      </button>
      {charEditing ? (
        <>
          <button
            className="btn ghost sm"
            type="button"
            onClick={cancelEditing}
            title={text('放弃本次修改并返回档案', 'Discard these changes and return to the archive')}
          >
            <X size={11} /> {text('取消', 'Cancel')}
          </button>
          {/* 先生：保存按钮统一用虚框，实心主色只留给「编辑档案」那类
              进入动作；删除才是红底白字。 */}
          <button
            className="btn outline sm"
            type="button"
            onClick={() => { void handleSave(true) }}
            disabled={identityBusy || !dataReady}
          >
            <Save size={11} /> {text('保存修改', 'Save changes')}
          </button>
        </>
      ) : (
        <>
          <button
            className="btn outline sm"
            type="button"
            onClick={handleDelete}
            disabled={identityBusy || !dataReady}
            title={text('删除该角色', 'Delete this character')}
          >
            <Trash2 size={11} /> {text('删除', 'Delete')}
          </button>
          <button className="btn primary sm" type="button" onClick={beginEditing}>
            <PenLine size={11} /> {text('编辑档案', 'Edit profile')}
          </button>
        </>
      )}
    </>
  ) : (
    <button
      className="btn outline sm"
      type="button"
      onClick={openRelationshipGraph}
      title={text('在独立标签页里查看全员关系网', 'Open the full relationship graph in its own tab')}
    >
      <Network size={11} /> {text('关系图谱', 'Relationship graph')}
    </button>
  )

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
      {/* 主体区：档案走 demo 的 920px 滚动档案栏。
          关系图谱已改为独立标签页（见 RelationsEditor），不再嵌在这里 ——
          这样打开图谱之后，档案标签原地不动，点回去就回到档案。 */}
      <div className="flex-1 overflow-y-auto relative">
        <div style={ARCHIVE_SCROLL_STYLE}>
            {/* v3：档案铭牌 —— 结构不同的一版页头。
                旧的 .pagehead 是「小字眉标 → 大字标题 → 小字说明」三行文字；
                这一版把信息画出来：自绘栏目徽记、自绘关系缩略网、期刊化章号块。
                v2 墨纸书斋走下面那条原路径，逐像素不变。 */}
            {magazine ? (
              /* v3：铭牌住进 `.pagehead-strip` —— 与设定集 / 剧情树 / 伏笔的页头**同一容器**，
                 于是版心（1080px）、左缘内距（36px）、上留白（30px）天然一致。
                 先生：「人物档案这里的页面排列没有和设定集，剧情树与伏笔看齐」——
                 真相是这块铭牌原先直接躺在滚动栏里，没有那 36px 内距，
                 整块比别的页头往左偏了一格（他先说的是「往左移」，随后自己纠正为「没看齐」）。 */
              <div className="pagehead-strip">
              <CharacterProfilePlate
                name={selectedCard ? (selectedCard.name || text('未命名', 'Untitled')) : text('角色档案', 'Character profile')}
                roleName={roleName}
                roleKind={selectedCard?.role ?? 'minor'}
                updatedAtChapter={updatedAtChapter}
                relationships={selectedCard?.relationships ?? ''}
                rosterNames={rosterNames}
                avatarUrl={avatarUrl}
                avatarInitial={avatarInitial}
                avatarBusy={avatarBusy}
                canChooseAvatar={charEditing}
                onChooseAvatar={() => { void chooseAvatar() }}
                notice={avatarNotice
                  ? <p role="status" style={AVATAR_NOTICE_STYLE}>{avatarNotice}</p>
                  : null}
                actions={headerActions}
              />
              </div>
            ) : (
            /* 页头移出 920px 档案栏，与其它子菜单同一位置、同一宽度（先生：角色档案也要规整） */
            <div className="pagehead-strip">
              <div className="pagehead">
                <div className="ph-t">
                  <div className="ph-k">{text('CAST · 人物档案', 'CAST · Character profile')}</div>
                  <h1>{selectedCard ? (selectedCard.name || text('未命名', 'Untitled')) : text('角色档案', 'Character profile')}</h1>
                  <div className="ph-d">{headerDetail}</div>
                </div>
                <div className="ph-a">{headerActions}</div>
              </div>
            </div>
            )}

            <div style={ARCHIVE_PAGE_STYLE}>
              {/* demo 3451–3455 行：头像行。
                  v3 下整行不渲染 —— 头像、姓名、定位、换头像入口都已经并进上面那块
                  档案铭牌里；两处都画就会同名同脸重复两遍。 */}
              {selectedCard && !magazine && (
                <>
                  <div style={AVATAR_ROW_STYLE}>
                    <div className="character-avatar-wrap">
                      {avatarUrl
                        ? <img src={avatarUrl} alt="" style={AVATAR_IMAGE_STYLE} />
                        : <span style={AVATAR_INITIAL_STYLE}>{avatarInitial}</span>}
                      {/* demo 3452 行：悬停浮现的更换头像按钮（.avatar-picker-hit 见 shell.css 842）。
                          先生：头像只在编辑档案时可改 —— 阅览态不给入口，改动也只在保存
                          档案那一刻才生效，避免「点一下就永久改掉头像」。 */}
                      {charEditing && (
                        <button
                          type="button"
                          className="avatar-picker-hit"
                          title={text('更换头像（保存档案后生效）', 'Change avatar (takes effect when you save)')}
                          aria-label={text('更换头像', 'Change avatar')}
                          disabled={avatarBusy}
                          onClick={() => void chooseAvatar()}
                        >
                          <Camera size={17} />
                        </button>
                      )}
                    </div>
                    <div style={AVATAR_BLOCK_STYLE}>
                      <b style={AVATAR_NAME_STYLE}>{selectedCard.name || text('未命名', 'Untitled')}</b>
                      <div style={AVATAR_ROLE_STYLE}>{avatarSubtitle}</div>
                    </div>
                    <span className={`badge ${selectedCard.role === 'protagonist' ? 'seal' : 'v'}`}>{roleName}</span>
                  </div>
                  {avatarNotice && <p role="status" style={AVATAR_NOTICE_STYLE}>{avatarNotice}</p>}
                </>
              )}

              {!selectedCard ? (
                <BaseEmptyState
                  icon={<Users size={36} />}
                  message={lastError
                    ? text(`角色卡读取失败：${lastError}`, `Could not load character cards: ${lastError}`)
                    : (currentProject ? text('在左侧选择或创建角色卡', 'Select or create a character card on the left') : text('请先打开项目', 'Open a project first'))}
                  opacity={currentProject ? 0.3 : 0.4}
                />
              ) : (
                <>
                  {charEditing ? (
                    <>
                      {/* demo 3457 行：编辑条。先生：自定义头像要有撤回入口，
                          否则传错图就没法收场 —— 编辑条右侧固定一个「移除头像」，
                          只在确有自定义头像时出现。 */}
                      <div className="archive-editbar">
                        <span style={EDITBAR_HINT_STYLE}>
                          {text('编辑状态 · 修改后保存才会写入档案', 'Editing · changes reach the archive only after you save')}
                        </span>
                        {avatarUrl && (
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={avatarBusy}
                            onClick={stageRemoval}
                            title={text('保存档案后删除自定义头像，回到姓名首字头像', 'Removing takes effect when you save: the avatar falls back to the name initial')}
                          >
                            <Trash2 size={11} /> {text('移除头像', 'Remove avatar')}
                          </button>
                        )}
                      </div>
                      {viewMode === 'state' ? (
                        <>
                          {/* demo 3467–3473 行：当前状态编辑态 */}
                          <div className="archive-grid" style={STATE_GRID_STYLE}>
                            {STATE_GRID_FIELDS.map(field => (
                              <MiniField key={field.key} label={text(field.zh, field.en)} note={stateFieldNote(field.key)}>
                                <input
                                  value={currentState[field.key]}
                                  onChange={event => updateStateField(field.key, event.target.value)}
                                />
                              </MiniField>
                            ))}
                          </div>
                          {STATE_TEXT_FIELDS.map(field => (
                            <BigField
                              key={field.key}
                              label={text(field.zh, field.en)}
                              note={stateFieldNote(field.key)}
                              value={currentState[field.key]}
                              placeholder={`${text(field.zh, field.en)}...`}
                              onChange={value => updateStateField(field.key, value)}
                            />
                          ))}
                        </>
                      ) : (
                        <>
                          {/* demo 3459–3464 行：基础档案编辑态 */}
                          <div className="archive-grid" style={PROFILE_GRID_STYLE}>
                            <MiniField label={text('姓名', 'Name')}>
                              <input
                                value={selectedCard.name}
                                disabled={identityBusy}
                                onChange={event => renameCurrentCharacter(selectedCard.name, event.target.value)}
                              />
                            </MiniField>
                            <MiniField label={text('性别', 'Gender')}>
                              <input
                                value={selectedCard.gender}
                                onChange={event => updateCurrentField(selectedCard.name, 'gender', event.target.value)}
                              />
                            </MiniField>
                            <MiniField label={text('年龄', 'Age')}>
                              <input
                                value={selectedCard.age}
                                onChange={event => updateCurrentField(selectedCard.name, 'age', event.target.value)}
                              />
                            </MiniField>
                            <MiniField label={text('定位', 'Role')}>
                              <select
                                value={selectedCard.role}
                                onChange={event => updateCurrentField(selectedCard.name, 'role', event.target.value as CharacterCard['role'])}
                              >
                                {CHARACTER_ROLES.map(role => (
                                  <option key={role} value={role}>{roleLabel(role)}</option>
                                ))}
                              </select>
                            </MiniField>
                          </div>
                          {PROFILE_FIELDS_BEFORE_RELATIONSHIPS.map(field => (
                            <BigField
                              key={field.key}
                              label={text(field.zh, field.en)}
                              value={selectedCard[field.key]}
                              placeholder={text(field.placeholderZh, field.placeholderEn)}
                              onChange={value => updateCurrentField(selectedCard.name, field.key, value)}
                            />
                          ))}
                          <BigField
                            label={text('关系网', 'Relationships')}
                            value={relationshipDraftText ?? relationshipEditorText}
                            placeholder={text(
                              '每行一位角色，例如：陆云飞：竞争对手（权力斗争）',
                              'One character per line, for example: Lu Yunfei: rival (power struggle)',
                            )}
                            onChange={value => {
                              // 先留住作者原文（含刚敲下的换行），再同步结构化存储。
                              if (editSnapshot) {
                                setRelationshipDraft({ sessionId: editSnapshot.sessionId, text: value })
                              }
                              updateCurrentField(
                                selectedCard.name,
                                'relationships',
                                relationshipStorageFromEditor(value, {
                                  knownNames: characters.map((character) => character.name),
                                  selfName: selectedCard.name,
                                  previousStorage: selectedCard.relationships,
                                }),
                              )
                            }}
                          />
                          {unregisteredTargets.length > 0 && (
                            <div
                              className="flex items-center justify-between gap-3 rounded-lg mt-2 px-3 py-2 text-[0.72rem]"
                              style={{
                                backgroundColor: 'var(--color-sidebar)',
                                border: '1px solid var(--color-border)',
                                color: 'var(--color-text-secondary)',
                              }}
                            >
                              <span>
                                {text(
                                  `关系里提到 ${unregisteredTargets.length} 个还没登记的角色：${unregisteredTargets.join('、')}。建立后关系会自动变成结构化关系，保存即落盘。`,
                                  `${unregisteredTargets.length} relationship target(s) are not registered yet: ${unregisteredTargets.join(', ')}. Creating them turns these lines into structured relationships; save to persist.`,
                                )}
                              </span>
                              <button
                                type="button"
                                className="btn ghost sm flex-shrink-0"
                                onClick={() => addNamedCharacters(unregisteredTargets)}
                              >
                                {text('建立为角色卡', 'Create character cards')}
                              </button>
                            </div>
                          )}
                          {PROFILE_FIELDS_AFTER_RELATIONSHIPS.map(field => (
                            <BigField
                              key={field.key}
                              label={text(field.zh, field.en)}
                              value={selectedCard[field.key]}
                              placeholder={text(field.placeholderZh, field.placeholderEn)}
                              onChange={value => updateCurrentField(selectedCard.name, field.key, value)}
                            />
                          ))}
                        </>
                      )}
                    </>
                  ) : (
                    <div className="archive-view">
                      {viewMode === 'state' ? (
                        <>
                          {/* demo 3483–3484 行：当前状态查看态 */}
                          <div className="archive-grid">
                            {STATE_GRID_FIELDS.map(field => {
                              const note = stateFieldNote(field.key)
                              return (
                                <div className="archive-item" key={field.key}>
                                  <b>
                                    {text(field.zh, field.en)}
                                    {note ? <i style={FIELD_NOTE_STYLE}>{note}</i> : null}
                                  </b>
                                  <span>{currentState[field.key]}</span>
                                </div>
                              )
                            })}
                          </div>
                          {STATE_TEXT_FIELDS.map(field => (
                            <ArchiveSection
                              key={field.key}
                              label={text(field.zh, field.en)}
                              note={stateFieldNote(field.key)}
                              value={currentState[field.key]}
                            />
                          ))}
                        </>
                      ) : (
                        <>
                          {/* demo 3478–3480 行：基础档案查看态 */}
                          <div className="archive-grid">
                            <div className="archive-item">
                              <b>{text('性别', 'Gender')}</b>
                              <span>{selectedCard.gender}</span>
                            </div>
                            <div className="archive-item">
                              <b>{text('年龄', 'Age')}</b>
                              <span>{selectedCard.age}</span>
                            </div>
                            <div className="archive-item">
                              <b>{text('定位', 'Role')}</b>
                              <span>{roleName}</span>
                            </div>
                            <div className="archive-item">
                              <b>{text('最近更新', 'Last updated')}</b>
                              <span>{updatedAtChapter > 0 ? text(`第 ${updatedAtChapter} 章`, `Chapter ${updatedAtChapter}`) : ''}</span>
                            </div>
                          </div>
                          <ArchiveSection label={text('外貌描写', 'Appearance')} value={selectedCard.appearance} lead />
                          {PROFILE_FIELDS_BEFORE_RELATIONSHIPS.slice(1).map(field => (
                            <ArchiveSection
                              key={field.key}
                              label={text(field.zh, field.en)}
                              value={selectedCard[field.key]}
                            />
                          ))}
                          <ArchiveSection label={text('关系网', 'Relationships')} value={relationshipEditorText} />
                          {PROFILE_FIELDS_AFTER_RELATIONSHIPS.map(field => (
                            <ArchiveSection
                              key={field.key}
                              label={text(field.zh, field.en)}
                              value={selectedCard[field.key]}
                            />
                          ))}
                        </>
                      )}
                    </div>
                  )}

                  {viewMode === 'state' && !selectedCard.currentState && (
                    <div style={STATE_HINT_STYLE}>
                      {text('当前状态档案将在章节定稿后由 AI 自动更新，也可手动填写初始状态。', 'AI updates this profile after a chapter is finalized. You can also enter an initial state manually.')}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
      </div>
    </div>
  )
}
