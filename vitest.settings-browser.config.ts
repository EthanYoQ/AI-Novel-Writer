import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const executablePath = process.env.AI_NOVEL_VITEST_CHROMIUM
// 浏览器的 navigator.language 固定为中文，不跟运行器系统语言走。设 AI_NOVEL_VITEST_LOCALE=en-US 可在本机复现英文 CI：
// 此时断言中文文案的用例（包括 runner-locale.browser.tsx）会像英文运行器上那样失败。
const browserLocale = process.env.AI_NOVEL_VITEST_LOCALE || 'zh-CN'

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
      provider: playwright({ ...(executablePath ? { launchOptions: { executablePath } } : {}), contextOptions: { locale: browserLocale } }),
      instances: [{ browser: 'chromium' }],
      headless: true,
      fileParallelism: false,
    },
  },
})
