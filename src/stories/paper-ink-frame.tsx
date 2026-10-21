import type { Decorator } from '@storybook/react'

/** 把 Storybook 工具栏的主题带进纸墨作用域。 */
export const paperInkFrame: Decorator = (Story, context) => {
  const theme = (context.globals as { theme?: string }).theme
  return (
    <div className="paper-ink" data-theme={theme === 'dark' ? 'dark' : 'light'} style={{ padding: 32, minHeight: 360 }}>
      <Story />
    </div>
  )
}
