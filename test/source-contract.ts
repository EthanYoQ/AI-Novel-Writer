import { readFileSync } from 'node:fs'

/**
 * Source-level contract tests intentionally ignore checkout line endings.
 * Git may materialize the same tracked source as LF or CRLF on Windows.
 */
export function normalizeSourceEol(source: string): string {
  return source.replace(/\r\n?/g, '\n')
}

/**
 * Read a tracked source file through the same canonical EOL boundary used by
 * source-contract assertions and content hashes.
 */
export function readNormalizedSource(sourcePath: string): string {
  return normalizeSourceEol(readFileSync(sourcePath, 'utf8'))
}
