import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { readFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'

// Vitest 把 port 0 当作未设置并退回固定的 63315，只能先向系统要一个空闲端口。
const freeLoopbackPort = () => new Promise<number>((resolve, reject) => {
  const server = createServer().once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo
    server.close(() => resolve(port))
  })
})

const executablePath = process.env.AI_NOVEL_VITEST_CHROMIUM
const browserApiPort = Number(process.env.AI_NOVEL_VITEST_BROWSER_API_PORT || 0) || await freeLoopbackPort()
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
      // Windows/HNS can reserve any fixed high port, including on hosted CI.
      // Let the OS allocate an available port unless a caller explicitly fixes one.
      api: { host: '127.0.0.1', port: browserApiPort },
      provider: playwright(executablePath ? { launchOptions: { executablePath } } : undefined),
      instances: [{ browser: 'chromium' }],
      headless: true,
      fileParallelism: false,
    },
  },
})
