/* eslint-env node */

const expectedContext = 'release-win-verify'

if (process.env.AI_NOVEL_RELEASE_GATE !== expectedContext) {
  console.error(
    'Direct Windows artifact builds are blocked. Run "pnpm run build:win" so the complete release verification gate executes.',
  )
  process.exit(1)
}

if (process.env.npm_lifecycle_event !== 'build:win:artifacts') {
  console.error('The Windows artifact guard may only run inside the build:win:artifacts lifecycle.')
  process.exit(1)
}
