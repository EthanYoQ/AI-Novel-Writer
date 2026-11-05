import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  AuthoritativeChapterSequenceError,
  readWritableChapters,
} from '../authoritative-chapter-sequence'

const PROJECT_PATH = 'C:\\novels\\authoritative-sequence'
const PROJECT_SESSION: ProjectSessionContext = {
  projectId: 'authoritative-sequence',
  leaseId: 'lease-authoritative-sequence',
  projectPath: PROJECT_PATH,
}

function installSequence(result: unknown) {
  const invoke = vi.fn().mockResolvedValue(result)
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
  return invoke
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readWritableChapters', () => {
  it.each([
    ['empty authority', { status: 'empty', lastChapterNumber: 0, nextChapterNumber: 1, gaps: [], duplicateChapterNumbers: [], authorityFingerprint: 'a'.repeat(64) },
      { next: 1, gaps: [], writable: [1] }],
    ['continuous Chapters 1 through 9', { status: 'continuous', lastChapterNumber: 9, nextChapterNumber: 10, gaps: [], duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64) },
      { next: 10, gaps: [], writable: [10] }],
    ['a deleted Chapter 4 among nine', { status: 'gapped', lastChapterNumber: 9, nextChapterNumber: 10, gaps: [{ from: 4, to: 5, cause: 'deleted' }], duplicateChapterNumbers: [], authorityFingerprint: 'c'.repeat(64) },
      { next: 10, gaps: [{ from: 4, to: 5, cause: 'deleted' }], writable: [4, 10] }],
  ] as const)('returns the writable chapters for %s', async (_label, sequence, expected) => {
    const invoke = installSequence(sequence)

    await expect(readWritableChapters(PROJECT_SESSION, 'zh-CN')).resolves.toEqual(expected)
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-authority-sequence',
      PROJECT_PATH,
      PROJECT_SESSION,
    )
  })

  it.each([
    ['a NaN next chapter', { nextChapterNumber: Number.NaN, gaps: [] }],
    ['a zero next chapter', { nextChapterNumber: 0, gaps: [] }],
    ['a fractional next chapter', { nextChapterNumber: 1.5, gaps: [] }],
    ['a gap that starts at NaN', { nextChapterNumber: 10, gaps: [{ from: Number.NaN, to: 5, cause: 'deleted' }] }],
    ['a gap that starts at 0', { nextChapterNumber: 10, gaps: [{ from: 0, to: 5, cause: 'deleted' }] }],
    ['no gap list', { nextChapterNumber: 10 }],
  ])('rejects a malformed sequence with %s as invalid authority instead of offering it', async (_label, fields) => {
    installSequence({
      status: 'gapped', lastChapterNumber: 9, duplicateChapterNumbers: [], authorityFingerprint: 'e'.repeat(64), ...fields,
    })

    await expect(readWritableChapters(PROJECT_SESSION, 'zh-CN')).rejects.toEqual(
      expect.objectContaining<Partial<AuthoritativeChapterSequenceError>>({
        code: 'AUTHORITATIVE_CHAPTER_SEQUENCE_INVALID',
        message: expect.not.stringMatching(/重复/u),
      }),
    )
  })

  it('rejects duplicate finalized authority with exact chapter numbers', async () => {
    installSequence({
      status: 'invalid',
      lastChapterNumber: 9,
      gaps: [],
      duplicateChapterNumbers: [3, 7],
      authorityFingerprint: 'd'.repeat(64),
    })

    await expect(readWritableChapters(PROJECT_SESSION, 'zh-CN')).rejects.toEqual(
      expect.objectContaining<Partial<AuthoritativeChapterSequenceError>>({
        code: 'AUTHORITATIVE_CHAPTER_SEQUENCE_INVALID',
        message: expect.stringMatching(/第 3、7 章.*重复/u),
      }),
    )
  })
})
