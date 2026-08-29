import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  AuthoritativeChapterSequenceError,
  readAuthoritativeNextChapter,
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
    velaAPI: {
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

describe('authoritative next-chapter renderer boundary', () => {
  it.each([
    ['empty authority', { status: 'empty', lastChapterNumber: 0, nextChapterNumber: 1, duplicateChapterNumbers: [], authorityFingerprint: 'a'.repeat(64) }, 1],
    ['continuous Chapters 1 through 9', { status: 'continuous', lastChapterNumber: 9, nextChapterNumber: 10, duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64) }, 10],
  ] as const)('returns the next chapter for %s', async (_label, sequence, expected) => {
    const invoke = installSequence(sequence)

    await expect(readAuthoritativeNextChapter(PROJECT_SESSION, 'zh-CN')).resolves.toBe(expected)
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-authority-sequence',
      PROJECT_PATH,
      PROJECT_SESSION,
    )
  })

  it('rejects a gap with an actionable localized error instead of inventing a count', async () => {
    installSequence({
      status: 'invalid',
      lastChapterNumber: 9,
      firstGapChapterNumber: 4,
      duplicateChapterNumbers: [],
      authorityFingerprint: 'c'.repeat(64),
    })

    await expect(readAuthoritativeNextChapter(PROJECT_SESSION, 'en-US')).rejects.toMatchObject({
      name: 'AuthoritativeChapterSequenceError',
      code: 'AUTHORITATIVE_CHAPTER_SEQUENCE_INVALID',
      message: expect.stringContaining('Chapter 4 is missing'),
    })
  })

  it('rejects duplicate finalized authority with exact chapter numbers', async () => {
    installSequence({
      status: 'invalid',
      lastChapterNumber: 9,
      duplicateChapterNumbers: [3, 7],
      authorityFingerprint: 'd'.repeat(64),
    })

    await expect(readAuthoritativeNextChapter(PROJECT_SESSION, 'zh-CN')).rejects.toEqual(
      expect.objectContaining<Partial<AuthoritativeChapterSequenceError>>({
        code: 'AUTHORITATIVE_CHAPTER_SEQUENCE_INVALID',
        message: expect.stringMatching(/第 3、7 章.*重复/u),
      }),
    )
  })
})
