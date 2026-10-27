import { useCallback, useEffect, useState } from 'react'
import type { ImportFillField, ImportFillSuggestion } from '../../../shared/import-fill-empty'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import type { WorkflowRun } from '../../../stores/workflow-store'
import { adoptImportSuggestions, loadPendingImportSuggestions } from '../../../services/workflows/import-suggestions'
import { isCurrentSessionRun } from '../../run/run-failure'
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
  const current = useProjectStore(() => isCurrentSessionRun(run))
  const [items, setItems] = useState<ImportFillSuggestion[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(() => loadPendingImportSuggestions(run.id, run.projectSession, run.projectPath), [run])

  useEffect(() => {
    if (!current) return
    let active = true
    void reload().then(next => { if (active) setItems(next) }).catch(() => undefined)
    return () => { active = false }
  }, [current, reload])

  const adopt = async (chosen: ImportFillSuggestion[]) => {
    setBusy(true)
    setError('')
    try {
      await adoptImportSuggestions(chosen, run.projectSession, run.projectPath)
      setItems(await reload())
    } catch (failure) {
      setError(displayedErrorMessage(locale, failure))
    } finally {
      setBusy(false)
    }
  }

  if (!current || items.length === 0) return null
  const show = (value: string | number) => {
    const choice = CHOICE_NAMES.get(String(value))
    return choice ? text(...choice) : String(value)
  }
  return (
    <section className="run-suggestions" aria-label={text('反推建议', 'Inferred suggestions')}>
      <p className="run-confirm-summary">{text(`${items.length} 条反推结果与你已有的内容不同`, `${items.length} inferred ${items.length === 1 ? 'value differs' : 'values differ'} from what you wrote`)}</p>
      <p className="run-note">{text('导入没有改动这些内容。需要的话逐条采用，采用后会替换现有内容。', 'The import left these unchanged. Adopt any you want; adopting replaces what is there now.')}</p>
      <ul className="run-suggestion-list">
        {items.map(item => {
          const name = text(...FIELD_NAMES[item.field])
          return (
            <li key={item.field} className="run-suggestion">
              <div className="run-suggestion-head">
                <span className="run-suggestion-name">{name}</span>
                <Button variant="secondary" size="sm" disabled={busy} aria-label={text(`采用「${name}」的反推结果`, `Adopt the inferred ${name}`)}
                  onClick={() => void adopt([item])}>
                  {text('采用', 'Adopt')}
                </Button>
              </div>
              <dl className="run-suggestion-values">
                <dt>{text('现在', 'Now')}</dt>
                <dd>{show(item.current)}</dd>
                <dt>{text('反推', 'Inferred')}</dt>
                <dd>{show(item.inferred)}</dd>
              </dl>
            </li>
          )
        })}
      </ul>
      {error && <p className="run-note" data-tone="danger" role="alert">{error}</p>}
      {items.length > 1 && (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void adopt(items)}>{text('全部采用', 'Adopt all')}</Button>
      )}
    </section>
  )
}
