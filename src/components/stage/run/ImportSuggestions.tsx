import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { ImportFillField, ImportFillSuggestion } from '../../../shared/import-fill-empty'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import type { WorkflowRun } from '../../../stores/workflow-store'
import { adoptImportSuggestions, loadPendingImportSuggestions } from '../../../services/workflows/import-suggestions'
import { projectSessionContextFromProject, sameProjectPathKey } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { POV_OPTIONS, STRUCTURE_OPTIONS } from '../setup/setup-fields'
import { Button } from '../../ui/Button'

type Pair = readonly [string, string]

const FIELD_NAMES: Record<ImportFillField, Pair> = {
  genre: ['类型', 'Genre'],
  subGenre: ['细分类型', 'Subgenre'],
  targetAudience: ['目标读者', 'Target readers'],
  totalChapters: ['总章数', 'Total chapters'],
  wordsPerChapter: ['每章字数', 'Words per chapter'],
  plotStructure: ['故事结构', 'Story structure'],
  narrativePov: ['叙事视角', 'Point of view'],
  goldenFinger: ['金手指', 'Core hook'],
  globalGuidance: ['全局写作要求', 'Global guidance'],
  coreOutline: ['核心大纲', 'Core outline'],
  worldSetting: ['世界观（设定）', 'World (setup)'],
  protagonistProfile: ['主角人设', 'Protagonist'],
  premise: ['故事前提', 'Premise'],
  worldbuilding: ['世界观（架构）', 'World (architecture)'],
  synopsis: ['情节大纲', 'Plot outline'],
  writingStyle: ['文风', 'Writing style'],
}

const CHOICE_NAMES = new Map<string, Pair>([...POV_OPTIONS, ...STRUCTURE_OPTIONS])

/**
 * 作者原稿反推只补空白；与已有内容不同的反推结果在这里逐条采用。
 * 列表每次从收据和当前设定算出来，采用过或作者改成一样的不再出现。
 */
export function ImportSuggestions({ run }: { run: WorkflowRun }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const projectId = useProjectStore(s => s.currentProject?.id)
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const sessionLease = useProjectStore(s => s.currentProject?.sessionLease)
  // 建议存在这次运行的收据里：同一作品重开后会话换了新的，用当前会话照样能读；换成别的作品就不显示。
  // 只随会话本身变化，设定页改字段不触发重读。
  const session = useMemo(() => {
    const current = projectId && projectPath && sessionLease
      ? projectSessionContextFromProject({ id: projectId, path: projectPath, sessionLease }) : null
    return current && sameProjectPathKey(run.projectPath, current.projectPath) && current.projectId === run.projectSession?.projectId
      ? current : null
  }, [projectId, projectPath, sessionLease, run.projectPath, run.projectSession?.projectId])
  // 读到的建议与错误记着属于哪个会话：会话换了，新会话读完之前不显示旧会话的内容。
  const [loaded, setLoaded] = useState<{ session: ProjectSessionContext | null; items: ImportFillSuggestion[]; error: string }>(
    { session: null, items: [], error: '' })
  const [busy, setBusy] = useState(false)
  const current = loaded.session === session
  const items = current ? loaded.items : []
  const error = current ? loaded.error : ''

  const reload = useCallback(async () => (
    session ? loadPendingImportSuggestions(run.id, session, run.projectPath) : []
  ), [run.id, run.projectPath, session])

  useEffect(() => {
    let active = true
    void reload().then(next => { if (active) setLoaded({ session, items: next, error: '' }) })
      .catch(failure => {
        if (active) setLoaded(previous => ({ session, items: previous.session === session ? previous.items : [], error: displayedErrorMessage(locale, failure) }))
      })
    return () => { active = false }
  }, [locale, reload, session])

  const adopt = async (chosen: ImportFillSuggestion[]) => {
    if (!session) return
    setBusy(true)
    setLoaded(previous => ({ ...previous, error: '' }))
    try {
      await adoptImportSuggestions(chosen, session, run.projectPath, run.id)
      const next = await reload()
      setLoaded(previous => previous.session === session ? { session, items: next, error: '' } : previous)
    } catch (failure) {
      setLoaded(previous => previous.session === session ? { ...previous, error: displayedErrorMessage(locale, failure) } : previous)
    } finally {
      setBusy(false)
    }
  }

  if (!session || (items.length === 0 && !error)) return null
  const show = (value: string | number) => {
    const choice = CHOICE_NAMES.get(String(value))
    return choice ? text(...choice) : String(value)
  }
  return (
    <section className="run-suggestions" aria-label={text('反推建议', 'Inferred suggestions')}>
      {items.length > 0 && (
        <>
          <p className="run-confirm-summary">{text(`${items.length} 条反推结果与你已有的内容不同`, `${items.length} inferred ${items.length === 1 ? 'value differs' : 'values differ'} from what you wrote`)}</p>
          <p className="run-note">{text('导入没有改动这些内容。需要的话逐条采用，采用后会替换现有内容。', 'The import left these unchanged. Adopt any you want; adopting replaces what is there now.')}</p>
          <ul className="run-suggestion-list">
            {items.map(item => (
              <SuggestionCard key={item.field} name={text(...FIELD_NAMES[item.field])} current={show(item.current)} inferred={show(item.inferred)}
                busy={busy} onAdopt={() => void adopt([item])} />
            ))}
          </ul>
        </>
      )}
      {error && <p className="run-note" data-tone="danger" role="alert">{error}</p>}
      {items.length > 1 && (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void adopt(items)}>{text('全部采用', 'Adopt all')}</Button>
      )}
    </section>
  )
}

function SuggestionCard({ name, current, inferred, busy, onAdopt }: {
  name: string
  current: string
  inferred: string
  busy: boolean
  onAdopt: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const valuesId = useId()
  const values = useRef<HTMLDListElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [truncated, setTruncated] = useState(false)

  useLayoutEffect(() => {
    const list = values.current
    // 展开后内容不再溢出，这时重测会让按钮消失、收不回来，所以只在收起时测量。
    if (!list || expanded) return
    const measure = () => setTruncated([...list.querySelectorAll('dd')].some(value => value.scrollHeight > value.clientHeight))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [expanded, current, inferred])

  return (
    <li className="run-suggestion">
      <div className="run-suggestion-head">
        <span className="run-suggestion-name">{name}</span>
        <Button variant="secondary" size="sm" disabled={busy} aria-label={text(`采用「${name}」的反推结果`, `Adopt the inferred ${name}`)}
          onClick={onAdopt}>
          {text('采用', 'Adopt')}
        </Button>
      </div>
      <dl ref={values} id={valuesId} className="run-suggestion-values" data-expanded={expanded || undefined}>
        <dt>{text('现在', 'Now')}</dt>
        <dd>{current}</dd>
        <dt>{text('反推', 'Inferred')}</dt>
        <dd>{inferred}</dd>
      </dl>
      {(expanded || truncated) && (
        <Button variant="text" size="sm" className="run-suggestion-toggle" aria-expanded={expanded} aria-controls={valuesId}
          onClick={() => setExpanded(value => !value)}>
          {expanded ? text('收起', 'Show less') : text('展开全文', 'Show all')}
          {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        </Button>
      )}
    </li>
  )
}
