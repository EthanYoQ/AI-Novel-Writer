import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, LifeBuoy, Search, X } from 'lucide-react'

import { Button } from '../ui/Button'
import { useHelpStore } from '../../stores/help-store'
import { useLocaleStore } from '../../stores/locale-store'
import {
  TROUBLESHOOTING_CATEGORIES,
  TROUBLESHOOTING_TOPICS,
  type TroubleshootingCategory,
  type TroubleshootingTopic,
} from './troubleshooting-topics'

/**
 * 常见错误排查面板。
 *
 * 与「新手教程」配成一对：教程负责从头走一遍，这里负责出事时按报错找答案。
 * 每条都先给「你可能会看到的报错原文」，让作者能把界面上的红字与条目对上；
 * 再给原因和按顺序照做的步骤。顶部可以按关键字（含错误码）搜、按类别筛。
 */
export default function TroubleshootingGuide() {
  const open = useHelpStore((s) => s.open)
  const closeHelp = useHelpStore((s) => s.closeHelp)
  const text = useLocaleStore((s) => s.text)
  const locale = useLocaleStore((s) => s.locale)

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<TroubleshootingCategory | 'all'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeHelp()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, closeHelp])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return TROUBLESHOOTING_TOPICS.filter((topic) => {
      if (category !== 'all' && topic.category !== category) return false
      if (!needle) return true
      const haystack = [
        topic.titleZh, topic.titleEn,
        ...topic.symptomZh, ...topic.symptomEn,
        topic.causeZh, topic.causeEn,
        ...topic.fixZh, ...topic.fixEn,
        ...(topic.codes ?? []),
      ].join(' ').toLocaleLowerCase()
      return haystack.includes(needle)
    })
  }, [query, category])

  if (!open) return null

  const topicTitle = (topic: TroubleshootingTopic) => text(topic.titleZh, topic.titleEn)
  const topicSymptoms = (topic: TroubleshootingTopic) => (
    locale === 'en-US' ? topic.symptomEn : topic.symptomZh
  )
  const topicFixes = (topic: TroubleshootingTopic) => (
    locale === 'en-US' ? topic.fixEn : topic.fixZh
  )

  return (
    <div
      onClick={closeHelp}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'color-mix(in srgb, var(--color-text) 34%, transparent)',
      }}
    >
      <section
        role="dialog"
        aria-label={text('常见错误排查', 'Common issues')}
        data-help-panel
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 660,
          maxWidth: '94vw',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-raised)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.22))',
          overflow: 'hidden',
        }}
      >
        {/* 头部：标题 + 搜索 + 关闭 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 10px' }}>
          <LifeBuoy size={15} style={{ color: 'var(--color-accent)', flex: 'none' }} />
          <b style={{ fontSize: 'var(--mag-fs-body, 14px)' }}>{text('常见错误排查', 'Common issues')}</b>
          <span style={{ fontSize: 'var(--mag-fs-micro, 11px)', color: 'var(--color-text-muted)' }}>
            {text('对着报错找答案', 'Match the error you saw')}
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={closeHelp}
            title={text('关闭', 'Close')}
            style={{ background: 'transparent', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer' }}
          >
            <X size={15} />
          </button>
        </div>

        {/* 搜索 */}
        <div style={{ position: 'relative', padding: '0 16px' }}>
          <Search
            size={13}
            style={{
              position: 'absolute',
              left: 27,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-text-muted)',
            }}
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={text('搜报错原文、关键字或错误码，例如 401、长度、向量', 'Search the error text, a keyword or an error code')}
            aria-label={text('搜索常见错误', 'Search common issues')}
            style={{
              width: '100%',
              height: 30,
              padding: '0 10px 0 28px',
              fontSize: 'var(--mag-fs-caption, 12.5px)',
              color: 'var(--color-text)',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 7,
              outline: 'none',
            }}
          />
        </div>

        {/* 分类 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 16px 8px' }}>
          {[{ id: 'all' as const, zh: '全部', en: 'All' }, ...TROUBLESHOOTING_CATEGORIES].map((item) => {
            const active = category === item.id
            return (
              <button
                key={item.id}
                type="button"
                data-help-category={item.id}
                onClick={() => setCategory(item.id)}
                style={{
                  padding: '3px 10px',
                  fontSize: 'var(--mag-fs-kicker, 11.5px)',
                  borderRadius: 99,
                  cursor: 'pointer',
                  color: active ? '#fff' : 'var(--color-text-secondary)',
                  background: active ? 'var(--color-accent)' : 'transparent',
                  border: `1px solid ${active ? 'transparent' : 'var(--color-border)'}`,
                }}
              >
                {text(item.zh, item.en)}
              </button>
            )
          })}
        </div>

        {/* 列表 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '2px 16px 16px' }}>
          {visible.length === 0 && (
            <p style={{ fontSize: 'var(--mag-fs-caption, 12.5px)', color: 'var(--color-text-muted)', padding: '18px 0' }}>
              {text('没有匹配的条目。可以把报错原文粘进搜索框再试。', 'Nothing matched. Try pasting the exact error text into the search box.')}
            </p>
          )}

          {visible.map((topic) => {
            const isOpen = expanded === topic.id
            return (
              <div
                key={topic.id}
                data-help-topic={topic.id}
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 9,
                  marginBottom: 8,
                  overflow: 'hidden',
                  background: isOpen ? 'var(--color-panel)' : 'transparent',
                }}
              >
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : topic.id)}
                  aria-expanded={isOpen}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 12px',
                    textAlign: 'left',
                    fontSize: 'var(--mag-fs-caption, 12.5px)',
                    fontWeight: 550,
                    color: 'var(--color-text)',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span style={{ flex: 1 }}>{topicTitle(topic)}</span>
                  <span style={{ fontSize: 'var(--mag-fs-kicker, 10.5px)', color: 'var(--color-text-muted)' }}>
                    {text(
                      TROUBLESHOOTING_CATEGORIES.find((c) => c.id === topic.category)?.zh ?? '',
                      TROUBLESHOOTING_CATEGORIES.find((c) => c.id === topic.category)?.en ?? '',
                    )}
                  </span>
                </button>

                {isOpen && (
                  <div style={{ padding: '0 12px 12px 33px', fontSize: 'var(--mag-fs-note, 12px)', lineHeight: 1.75 }}>
                    <div style={{ marginBottom: 8 }}>
                      <b style={{ fontSize: 'var(--mag-fs-kicker, 11.5px)', color: 'var(--color-text-muted)' }}>
                        {text('你可能会看到', 'What you may see')}
                      </b>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 16, color: 'var(--color-text-secondary)' }}>
                        {topicSymptoms(topic).map((line) => <li key={line}>{line}</li>)}
                      </ul>
                    </div>

                    <div style={{ marginBottom: 8 }}>
                      <b style={{ fontSize: 'var(--mag-fs-kicker, 11.5px)', color: 'var(--color-text-muted)' }}>
                        {text('为什么', 'Why')}
                      </b>
                      <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)' }}>
                        {text(topic.causeZh, topic.causeEn)}
                      </p>
                    </div>

                    <div>
                      <b style={{ fontSize: 'var(--mag-fs-kicker, 11.5px)', color: 'var(--color-text-muted)' }}>
                        {text('怎么办', 'How to fix it')}
                      </b>
                      <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {topicFixes(topic).map((line) => <li key={line}>{line}</li>)}
                      </ol>
                    </div>

                    {topic.codes && topic.codes.length > 0 && (
                      <p style={{ margin: '9px 0 0', fontSize: 'var(--mag-fs-micro, 11px)', color: 'var(--color-text-muted)' }}>
                        {text('相关错误码：', 'Error codes: ')}
                        {topic.codes.join(' · ')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 底部：与教程互相跳转 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderTop: '1px solid var(--color-border)' }}>
          <span style={{ fontSize: 'var(--mag-fs-kicker, 11.5px)', color: 'var(--color-text-muted)' }}>
            {text('没解决？先按上面的报错原文搜一次，再检查模型与项目设置。', 'Still stuck? Search with the exact error text, then check your model and project settings.')}
          </span>
          <div style={{ flex: 1 }} />
          <Button variant="outline" size="sm" onClick={closeHelp}>
            {text('知道了', 'Got it')}
          </Button>
        </div>
      </section>
    </div>
  )
}
