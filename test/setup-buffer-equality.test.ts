import { describe, expect, it } from 'vitest'

describe('Buffer equality in node tests', () => {
  const size = 4 * 1024 * 1024
  const original = Buffer.alloc(size, 7)

  it('compares project-sized byte snapshots within the default case budget', () => {
    expect(Buffer.from(original)).toEqual(original)
    expect({ database: Buffer.from(original) }).toStrictEqual({ database: original })
  })

  it('still reports a single changed byte as a difference', () => {
    const changed = Buffer.from(original)
    changed[size - 1] = 8
    expect(changed).not.toEqual(original)
    expect(Buffer.alloc(3)).not.toEqual(Buffer.alloc(4))
  })
})
