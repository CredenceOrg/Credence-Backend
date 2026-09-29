import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { getFlag, type FeatureFlag } from '../featureFlags'

describe('featureFlags', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('returns true when env var is "true"', () => {
    process.env.NEW_PIPELINE = 'true'
    expect(getFlag('newPipeline')).toBe(true)
  })

  it('returns true when env var is "1"', () => {
    process.env.NEW_PIPELINE = '1'
    expect(getFlag('newPipeline')).toBe(true)
  })

  it('returns false when env var is "false"', () => {
    process.env.NEW_PIPELINE = 'false'
    expect(getFlag('newPipeline')).toBe(false)
  })

  it('returns false when env var is undefined', () => {
    delete process.env.NEW_PIPELINE
    expect(getFlag('newPipeline')).toBe(false)
  })

  it('returns true when SHADOW_WRITE_MODE env var is "true"', () => {
    process.env.SHADOW_WRITE_MODE = 'true'
    expect(getFlag('shadowWriteMode')).toBe(true)
  })

  it('returns true when SHADOW_WRITE_MODE env var is "1"', () => {
    process.env.SHADOW_WRITE_MODE = '1'
    expect(getFlag('shadowWriteMode')).toBe(true)
  })

  it('returns false when SHADOW_WRITE_MODE env var is "false"', () => {
    process.env.SHADOW_WRITE_MODE = 'false'
    expect(getFlag('shadowWriteMode')).toBe(false)
  })

  it('returns false when SHADOW_WRITE_MODE env var is undefined', () => {
    delete process.env.SHADOW_WRITE_MODE
    expect(getFlag('shadowWriteMode')).toBe(false)
  })

  it.each(['TRUE', ' true', 'true ', 'yes', '0', '', 'false'])(
    'keeps both flags disabled for noncanonical value %j',
    (value) => {
      process.env.NEW_PIPELINE = value
      process.env.SHADOW_WRITE_MODE = value
      expect(getFlag('newPipeline')).toBe(false)
      expect(getFlag('shadowWriteMode')).toBe(false)
    },
  )

  it('reads the current value on every call, including after a bad value', () => {
    process.env.NEW_PIPELINE = 'true'
    expect(getFlag('newPipeline')).toBe(true)
    process.env.NEW_PIPELINE = 'invalid'
    expect(getFlag('newPipeline')).toBe(false)
    process.env.NEW_PIPELINE = '1'
    expect(getFlag('newPipeline')).toBe(true)
    delete process.env.NEW_PIPELINE
    expect(getFlag('newPipeline')).toBe(false)
  })

  it('keeps the two flags independent across changes', () => {
    process.env.NEW_PIPELINE = 'true'
    process.env.SHADOW_WRITE_MODE = 'false'
    expect(getFlag('newPipeline')).toBe(true)
    expect(getFlag('shadowWriteMode')).toBe(false)
    process.env.NEW_PIPELINE = 'false'
    process.env.SHADOW_WRITE_MODE = '1'
    expect(getFlag('newPipeline')).toBe(false)
    expect(getFlag('shadowWriteMode')).toBe(true)
  })

  it('rejects unknown and inherited keys even if coercion would find an enabled env var', () => {
    process.env.undefined = 'true'
    process.env['[object Object]'] = 'true'
    process.env['function toString() { [native code] }'] = 'true'

    for (const invalid of ['missing', '__proto__', 'toString', null] as unknown as FeatureFlag[]) {
      expect(getFlag(invalid)).toBe(false)
    }
  })
})
