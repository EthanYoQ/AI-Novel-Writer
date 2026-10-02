import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createOnboardingStore,
  ONBOARDING_STORAGE_KEY,
  readStoredOnboardingStatus,
} from '../onboarding-store'

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
    clear: () => storage.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('quick start onboarding store', () => {
  it('auto-opens only while the guide has never been seen', () => {
    const fresh = createOnboardingStore('pending')
    expect(fresh.getState().open).toBe(false)
    fresh.getState().openOnFirstRun()
    expect(fresh.getState().open).toBe(true)

    for (const status of ['completed', 'skipped'] as const) {
      const seen = createOnboardingStore(status)
      seen.getState().openOnFirstRun()
      expect(seen.getState().open).toBe(false)
    }
  })

  it('closes as completed once the author walks to the last step', () => {
    const store = createOnboardingStore('pending')
    store.getState().openOnFirstRun()
    store.getState().setStepIndex(6)
    store.getState().closeGuide('completed')

    expect(store.getState().open).toBe(false)
    expect(store.getState().status).toBe('completed')
    expect(storage.get(ONBOARDING_STORAGE_KEY)).toBe('completed')
    // 走过之后不再自动弹出……
    store.getState().openOnFirstRun()
    expect(store.getState().open).toBe(false)
    // ……但仍然可以手动重看，而且每次都从头开始。
    store.getState().openGuide()
    expect(store.getState().open).toBe(true)
    expect(store.getState().stepIndex).toBe(0)
  })

  it('records "skip all" as its own status', () => {
    const store = createOnboardingStore('pending')
    store.getState().openGuide()
    store.getState().markStepSkipped(0)
    store.getState().closeGuide('skipped')

    expect(store.getState().status).toBe('skipped')
    expect(storage.get(ONBOARDING_STORAGE_KEY)).toBe('skipped')
  })

  it('remembers which steps were skipped without duplicating them', () => {
    const store = createOnboardingStore('pending')
    store.getState().openGuide()
    store.getState().markStepSkipped(1)
    store.getState().markStepSkipped(1)
    store.getState().markStepSkipped(3)

    expect(store.getState().skippedSteps).toEqual([1, 3])
  })

  it('never lets the step index go negative', () => {
    const store = createOnboardingStore('pending')
    store.getState().setStepIndex(-3)
    expect(store.getState().stepIndex).toBe(0)
  })

  it('falls back to "never seen" when storage is missing or broken', () => {
    expect(readStoredOnboardingStatus()).toBe('pending')
    storage.set(ONBOARDING_STORAGE_KEY, 'nonsense')
    expect(readStoredOnboardingStatus()).toBe('pending')
    storage.set(ONBOARDING_STORAGE_KEY, 'completed')
    expect(readStoredOnboardingStatus()).toBe('completed')

    const throwing = {
      getItem: () => { throw new Error('storage disabled') },
    }
    expect(readStoredOnboardingStatus(throwing)).toBe('pending')
  })
})
