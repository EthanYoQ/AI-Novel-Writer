import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import ReviewReport from '../ReviewReport'

const originalLocale = useLocaleStore.getState().locale

afterEach(() => {
  useLocaleStore.setState({ locale: originalLocale })
})

describe('ReviewReport locale behavior', () => {
  it('renders English UI copy and Lucide severity icons when English is selected', () => {
    useLocaleStore.setState({ locale: 'en-US' })

    const html = renderToStaticMarkup(
      <ReviewReport
        projectKey="C:/projects/example"
        reportText={JSON.stringify({
          items: [{
            category: 'Continuity',
            severity: 'error',
            description: 'A character changes location without an explanation.',
          }],
          summary: 'Resolve the continuity issue before finalizing.',
        })}
      />,
    )

    expect(html).toContain('Review report')
    expect(html).toContain('1 critical')
    expect(html).toContain('Strongly recommended to fix')
    expect(html).not.toContain('审稿报告')
    expect(html).not.toContain('🔴')
  })
})
