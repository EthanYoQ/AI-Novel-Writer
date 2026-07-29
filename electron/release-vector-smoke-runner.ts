import {
  parseReleaseVectorSmokeInvocation,
  runReleaseVectorSmoke,
} from './services/release-vector-smoke'

async function main(): Promise<void> {
  const invocation = parseReleaseVectorSmokeInvocation(process.argv, process.env)
  if (!invocation) throw new Error('Invalid packaged vector smoke invocation')

  const timeout = setTimeout(() => {
    process.stderr.write('[AI Novel release vector smoke] Packaged vector smoke timed out after 90 seconds\n')
    process.exit(1)
  }, 90_000)
  try {
    const evidence = await runReleaseVectorSmoke(invocation.token)
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
  } finally {
    clearTimeout(timeout)
  }
}

void main().then(
  () => process.exit(0),
  () => {
    process.stderr.write('[AI Novel release vector smoke] failed\n')
    process.exit(1)
  },
)
