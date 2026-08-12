import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const executablePath = process.env.AI_NOVEL_VITEST_CHROMIUM

/**
 * Runs the few settings interactions that need a real browser DOM without
 * making the regular Node-focused Vitest suite launch Playwright.
 */
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    include: [
      'src/components/settings/__tests__/embedding-registration-entry.browser.tsx',
      'src/components/settings/__tests__/prompt-global-persistence.browser.tsx',
      'src/components/settings/__tests__/prompt-load-errors.browser.tsx',
    ],
    browser: {
      enabled: true,
      provider: playwright(executablePath ? { launchOptions: { executablePath } } : undefined),
      instances: [{ browser: 'chromium' }],
      headless: true,
      fileParallelism: false,
    },
  },
})
