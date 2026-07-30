import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('getVersionMetadata', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns the git SHA from GIT_SHA when set', async () => {
    process.env.GIT_SHA = 'deadbeefcafe'
    delete process.env.COMMIT_SHA
    const { getVersionMetadata } = await import('./version.js')

    expect(getVersionMetadata().gitSha).toBe('deadbeefcafe')
  })

  it('falls back to "unknown" gitSha in production when GIT_SHA/COMMIT_SHA are unset', async () => {
    // In production the module intentionally skips `git rev-parse` (no repo
    // on the deployed host), so this is the one path that must not throw or
    // leak `undefined` into the response body.
    delete process.env.GIT_SHA
    delete process.env.COMMIT_SHA
    process.env.NODE_ENV = 'production'
    const { getVersionMetadata } = await import('./version.js')

    expect(getVersionMetadata().gitSha).toBe('unknown')
  })

  it('never throws when no git SHA env vars or build metadata are available', async () => {
    delete process.env.GIT_SHA
    delete process.env.COMMIT_SHA
    delete process.env.BUILD_TIMESTAMP
    process.env.NODE_ENV = 'production'
    const { getVersionMetadata } = await import('./version.js')

    expect(() => getVersionMetadata()).not.toThrow()
  })

  it('caches metadata across calls within the same module instance', async () => {
    process.env.GIT_SHA = 'first-sha'
    const { getVersionMetadata } = await import('./version.js')
    const first = getVersionMetadata()

    process.env.GIT_SHA = 'second-sha'
    const second = getVersionMetadata()

    expect(second).toEqual(first)
  })
})
