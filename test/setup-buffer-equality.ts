import { expect } from 'vitest'

/**
 * Vitest's generic equality walks a Buffer byte by byte through its iterable
 * path, about 5 ms per KB. Tests that snapshot a project database before and
 * after an operation then spend seconds in one assertion. Byte equality is the
 * same verdict, computed natively.
 */
expect.addEqualityTesters([
  (a: unknown, b: unknown) => (Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : undefined),
])
