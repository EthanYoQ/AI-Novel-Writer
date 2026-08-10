import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { readFileSync } from 'node:fs'

const executablePath = process.env.AI_NOVEL_VITEST_CHROMIUM
const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
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
      api: { host: '127.0.0.1' },
      provider: playwright(executablePath ? { launchOptions: { executablePath } } : undefined),
      instances: [{ browser: 'chromium' }],
      headless: true,
      fileParallelism: false,
    },
  },
})
