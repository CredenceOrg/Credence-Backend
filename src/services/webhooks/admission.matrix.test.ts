import { describe, expect, it } from 'vitest'
import { InMemoryWebhookAdmissionStore, admitIncomingWebhook, signIncomingWebhook, validateFreshness, verifyIncomingSignature } from './admission.js'
import type { AdmissionInput } from './admission.js'

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  const value: AdmissionInput = {
    tenantId: 'tenant-a',
    eventId: 'provider-event-001',
    timestamp: 1_000,
    rawBody: Buffer.from('{"kind":"bond.created","value":42}', 'utf8'),
    signature: '',
    secret: 'tenant-secret-a',
  }
  const merged = { ...value, ...overrides }
  merged.signature = signIncomingWebhook(merged, merged.secret)
  return merged
}

describe('webhook admission mutation matrix', () => {
  it.each([
    ['tenant-a', 'provider-event-001', 1_000, '{"kind":"bond.created"}'],
    ['tenant-a', 'provider-event-002', 1_000, '{"kind":"bond.slashed"}'],
    ['tenant-b', 'provider-event-001', 1_000, '{"kind":"bond.created"}'],
    ['tenant-a', 'provider-event-001', 999, '{"kind":"bond.created"}'],
    ['tenant-a', 'provider-event-001', 1_001, '{"kind":"bond.created"}'],
  ])('accepts a correctly signed tuple %s/%s/%s', (tenantId, eventId, timestamp, rawBody) => {
    const value = input({ tenantId, eventId, timestamp, rawBody })
    expect(() => verifyIncomingSignature(value)).not.toThrow()
  })

  it.each([
    ['tenant-b', 'provider-event-001'],
    ['tenant-a', 'provider-event-002'],
    ['tenant-a', 'provider-event-003'],
    ['TENANT-A', 'provider-event-001'],
    ['tenant-a ', 'provider-event-001'],
  ])('rejects a signature copied to identity %s/%s', (tenantId, eventId) => {
    const original = input()
    expect(() => verifyIncomingSignature({ ...original, tenantId, eventId })).toThrow('invalid')
  })

  it.each([
    '{"kind":"bond.created"}',
    '{"kind":"bond.created","value":43}',
    '{"kind":"bond.created"}\n',
    '{ "kind": "bond.created" }',
    'null',
    '',
  ])('rejects raw body mutation %p', rawBody => {
    const original = input()
    expect(() => verifyIncomingSignature({ ...original, rawBody })).toThrow('invalid')
  })

  it.each([
    '00',
    'ff',
    'v1=00',
    'sha256=00',
    'not-a-signature',
    '',
    '0'.repeat(128),
  ])('rejects malformed signature %p', signature => {
    expect(() => verifyIncomingSignature({ ...input(), signature })).toThrow('invalid')
  })

  it.each([
    0,
    -1,
    -100,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid timestamp %p', timestamp => {
    const original = input()
    expect(() => verifyIncomingSignature({ ...original, timestamp })).toThrow('timestamp')
  })

  it.each([
    [699, 1_000, 300],
    [1_301, 1_000, 300],
    [0, 1_000, 999],
    [2_001, 1_000, 999],
  ])('rejects timestamp outside window %s/%s/%s', (timestamp, now, tolerance) => {
    expect(() => validateFreshness(timestamp, now, tolerance)).toThrow('outside')
  })

  it.each([
    [700, 1_000, 300],
    [1_300, 1_000, 300],
    [1_000, 1_000, 0],
    [0, 0, 0],
  ])('accepts timestamp at window boundary %s/%s/%s', (timestamp, now, tolerance) => {
    expect(() => validateFreshness(timestamp, now, tolerance)).not.toThrow()
  })

  it('does not claim an event when signature verification fails', () => {
    const store = new InMemoryWebhookAdmissionStore()
    expect(() => admitIncomingWebhook({ ...input(), signature: 'bad' }, store, 1_000)).toThrow()
    expect(store.size()).toBe(0)
  })

  it('does not claim an event when freshness verification fails', () => {
    const store = new InMemoryWebhookAdmissionStore()
    expect(() => admitIncomingWebhook(input(), store, 2_000)).toThrow()
    expect(store.size()).toBe(0)
  })

  it('claims only after both security checks pass', () => {
    const store = new InMemoryWebhookAdmissionStore()
    const result = admitIncomingWebhook(input(), store, 1_000)
    expect(result.outcome).toBe('accepted')
    expect(store.get('tenant-a', 'provider-event-001')).toBeDefined()
  })

  it('treats identical retries as a replay', () => {
    const store = new InMemoryWebhookAdmissionStore()
    const value = input()
    admitIncomingWebhook(value, store, 1_000)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(admitIncomingWebhook(value, store, 1_000).outcome).toBe('replay')
    }
  })

  it('rejects changed payloads even when the provider event ID is stable', () => {
    const store = new InMemoryWebhookAdmissionStore()
    const original = input()
    admitIncomingWebhook(original, store, 1_000)
    const changed = input({ rawBody: Buffer.from('{"kind":"bond.created","value":99}') })
    expect(admitIncomingWebhook(changed, store, 1_000).outcome).toBe('conflict')
  })

  it('allows a different tenant to use the same provider event ID', () => {
    const store = new InMemoryWebhookAdmissionStore()
    const first = input()
    const second = input({ tenantId: 'tenant-b', secret: 'tenant-secret-b' })
    expect(admitIncomingWebhook(first, store, 1_000).outcome).toBe('accepted')
    expect(admitIncomingWebhook(second, store, 1_000).outcome).toBe('accepted')
    expect(store.size()).toBe(2)
  })

  it('allows a tenant to process distinct event IDs', () => {
    const store = new InMemoryWebhookAdmissionStore()
    expect(admitIncomingWebhook(input(), store, 1_000).outcome).toBe('accepted')
    expect(admitIncomingWebhook(input({ eventId: 'provider-event-002' }), store, 1_000).outcome).toBe('accepted')
  })

  it('keeps the original outcome status on replay', () => {
    const store = new InMemoryWebhookAdmissionStore()
    const value = input()
    store.claim(value, 204, { accepted: true })
    const replay = store.claim(value, 500, { accepted: false })
    expect(replay.record?.statusCode).toBe(204)
    expect(replay.record?.responseBody).toEqual({ accepted: true })
  })

  it('updates the stored outcome without changing identity', () => {
    const store = new InMemoryWebhookAdmissionStore()
    const value = input()
    store.claim(value)
    store.complete(value.tenantId, value.eventId, value.rawBody, 200, { processed: true })
    const record = store.get(value.tenantId, value.eventId)
    expect(record?.tenantId).toBe(value.tenantId)
    expect(record?.eventId).toBe(value.eventId)
    expect(record?.responseBody).toEqual({ processed: true })
  })

  it('expires both accepted and completed records', () => {
    let clock = 0
    const store = new InMemoryWebhookAdmissionStore(() => clock, 10)
    const value = input()
    store.claim(value)
    store.complete(value.tenantId, value.eventId, value.rawBody, 200, {})
    clock = 10
    expect(store.get(value.tenantId, value.eventId)).toBeUndefined()
  })

  it('does not let a stale record block a fresh claim', () => {
    let clock = 0
    const store = new InMemoryWebhookAdmissionStore(() => clock, 10)
    const value = input()
    expect(store.claim(value).outcome).toBe('accepted')
    clock = 11
    expect(store.claim(value).outcome).toBe('accepted')
  })

  it('keeps record fingerprints stable for equivalent bytes', () => {
    const store = new InMemoryWebhookAdmissionStore()
    const value = input()
    const first = store.claim(value).record?.fingerprint
    const second = store.get(value.tenantId, value.eventId)?.fingerprint
    expect(first).toBe(second)
  })

  it('does not expose the secret in stored records', () => {
    const store = new InMemoryWebhookAdmissionStore()
    const value = input()
    const record = store.claim(value).record
    expect(JSON.stringify(record)).not.toContain(value.secret)
  })

  it('does not expose raw bytes in stored records', () => {
    const store = new InMemoryWebhookAdmissionStore()
    const value = input()
    const record = store.claim(value).record
    expect(JSON.stringify(record)).not.toContain('{"kind":"bond.created"')
  })
})
