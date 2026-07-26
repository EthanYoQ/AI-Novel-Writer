/**
 * Source-level contract tests intentionally ignore checkout line endings.
 * Git may materialize the same tracked source as LF or CRLF on Windows.
 */
export function normalizeSourceEol(source: string): string {
  return source.replace(/\r\n?/g, '\n')
}
