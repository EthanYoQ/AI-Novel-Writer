import type { Preview } from '@storybook/react'
import '../src/index.css'

const themes = ['light', 'galaxy', 'paper', 'dark'] as const

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'light',
      values: [
        { name: 'light', value: '#F7F9FC' },
        { name: 'galaxy', value: '#0A1628' },
        { name: 'paper', value: '#F5F0E8' },
        { name: 'dark', value: '#1E1E1E' },
      ],
    },
    a11y: {
      test: 'error',
    },
    docs: {
      theme: undefined, // Uses Storybook default theme
    },
  },
  decorators: [
    (Story, context) => {
      const theme = (context.globals as { theme?: typeof themes[number] }).theme || 'light'
      return (
        <div className={theme} style={{ padding: '1rem', minHeight: '200px' }}>
          <Story />
        </div>
      )
    },
  ],
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'Vela theme for preview',
      defaultValue: 'light',
      toolbar: {
        icon: 'circlehollow',
        items: themes.map(t => ({ value: t, title: t.charAt(0).toUpperCase() + t.slice(1) })),
        showName: true,
        dynamicLabel: true,
      },
    },
  },
}

export default preview
