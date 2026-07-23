import { getFlag } from '../featureFlags'

describe('featureFlags', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetModules()
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
})
