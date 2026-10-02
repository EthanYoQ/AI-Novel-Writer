import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'
import { readFileSync } from 'node:fs'

const executablePath = process.env.AI_NOVEL_VITEST_CHROMIUM
const browserApiPort = Number(process.env.AI_NOVEL_VITEST_BROWSER_API_PORT || 63450)
const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  /**
   * Tailwind 必须挂上：`src/index.css` 里 `@import "tailwindcss"` 排在若干 @font-face 之后
   * （第 75 行），浏览器原生的 @import 规则要求它必须最先出现，所以靠 @tailwindcss/vite 插件来解析。
   * 少了这个插件，浏览器测试里的 Tailwind 工具类会**静默失效** ——
   * 界面退化成裸 HTML，截图与真实应用对不上，样式类改动就验证不了。
   */
  plugins: [tailwindcss(), react()],
  optimizeDeps: {
    include: ['zustand/middleware'],
  },
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    include: ['src/**/*.browser.tsx'],
    setupFiles: ['test/setup-locale.ts'],
    browser: {
      enabled: true,
      // 63315 is frequently reserved by Windows/HNS. Keep this overridable
      // for CI, but use an unreserved default for local browser regressions.
      api: { host: '127.0.0.1', port: browserApiPort },
      provider: playwright(executablePath ? { launchOptions: { executablePath } } : undefined),
      instances: [{ browser: 'chromium' }],
      headless: true,
      fileParallelism: false,
    },
  },
})
