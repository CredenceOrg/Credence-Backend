import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_TEST_DATABASE_NAME,
  DEFAULT_TEST_DATABASE_URL,
  resolveTestDatabaseUrl,
} from '../testDatabase.js'

describe('testDatabase config', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.TEST_DATABASE_URL
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('exposes defaults aligned with docker-compose.test.yml', () => {
    expect(DEFAULT_TEST_DATABASE_NAME).toBe('credence_test')
    expect(DEFAULT_TEST_DATABASE_URL).toContain(DEFAULT_TEST_DATABASE_NAME)
    expect(DEFAULT_TEST_DATABASE_URL).toContain('5433')
  })

  it('resolveTestDatabaseUrl uses TEST_DATABASE_URL when set', () => {
    process.env.TEST_DATABASE_URL = 'postgresql://u:p@host:5432/custom_test'
    expect(resolveTestDatabaseUrl()).toBe('postgresql://u:p@host:5432/custom_test')
  })

  it('resolveTestDatabaseUrl falls back to default when unset', () => {
    expect(resolveTestDatabaseUrl()).toBe(DEFAULT_TEST_DATABASE_URL)
  })
})
