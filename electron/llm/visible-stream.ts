/** Incremental filtering for the main owner's visible-only stream. Protocol
 * reasoning fields never enter this filter. A partial tag is held until it can
 * be classified, so a split opening tag cannot leak a reasoning prefix. */
export class VisibleStreamFilter {
  private pending = ''
  private depth = 0
  private visible = ''

  push(text: string): string {
    const input = this.pending + text
    const parts: string[] = []
    this.pending = ''
    let cursor = 0
    while (cursor < input.length) {
      const opening = input.indexOf('<', cursor)
      const end = opening < 0 ? input.length : opening
      if (this.depth === 0 && end > cursor) parts.push(input.slice(cursor, end))
      if (opening < 0) break
      cursor = opening
      const tail = input.slice(cursor, cursor + 8).toLowerCase()
      const tag = tail.startsWith('<think>') ? '<think>'
        : tail.startsWith('</think>') ? '</think>' : null
      if (tag) {
        this.depth = tag === '<think>' ? this.depth + 1 : Math.max(0, this.depth - 1)
        cursor += tag.length
        continue
      }
      if (['<think>', '</think>'].some(candidate => candidate.startsWith(tail))) {
        this.pending = input.slice(cursor)
        break
      }
      if (this.depth === 0) parts.push('<')
      cursor += 1
    }
    const emitted = parts.join('')
    this.visible += emitted
    return emitted
  }

  /** Pending partial markup and an unfinished thought stay undisclosed. */
  get text(): string { return this.visible }
}
