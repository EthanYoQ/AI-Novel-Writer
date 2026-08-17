import { defineConfig, type UserConfig } from 'vitest/config'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export default defineConfig(async () => {
  const harnessRoot = process.env.DSH_HARNESS_ROOT
  const plugins: NonNullable<UserConfig['plugins']> = []
  if (harnessRoot !== undefined) {
    const moduleUrl = pathToFileURL(join(harnessRoot, 'node_modules', 'vite-tsconfig-paths', 'dist', 'index.js')).href
    const pathsModule = await import(moduleUrl) as {
      default(options: { readonly projects: readonly string[] }): NonNullable<UserConfig['plugins']>[number]
    }
    plugins.push(pathsModule.default({ projects: [join(harnessRoot, 'tsconfig.base.json')] }))
  }
  return {
    plugins,
    test: {
      environment: 'node',
      include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    },
  }
})
