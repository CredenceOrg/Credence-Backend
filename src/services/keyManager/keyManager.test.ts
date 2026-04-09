import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { decodeProtectedHeader } from 'jose'
import { KeyManager } from './index.js'
import { keyManager } from './index.js'

// ── Shared singleton tests (reset before each) ────────────────────────────────

describe('KeyManager (singleton)', () => {
  beforeEach(() => {
    keyManager._resetStore()
  })

  // ── initialize() ──────────────────────────────────────────────────────────

  describe('initialize()', () => {
    it('generates one active key on first call', async () => {
      await keyManager.initialize()
      const key = keyManager.getCurrentKey()
      expect(key).toBeDefined()
      expect(key.state).toBe('active')
    })

    it('assigns a UUID kid to the generated key', async () => {
      await keyManager.initialize()
      const { kid } = keyManager.getCurrentKey()
      expect(kid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    })

    it('is idempotent — calling twice does not create a second key', async () => {
      await keyManager.initialize()
      const kidFirst = keyManager.getCurrentKey().kid
      await keyManager.initialize()
      const kidSecond = keyManager.getCurrentKey().kid
      expect(kidFirst).toBe(kidSecond)
      expect(keyManager.getAllVerificationKeys()).toHaveLength(1)
    })
  })

  // ── getCurrentKey() ───────────────────────────────────────────────────────

  describe('getCurrentKey()', () => {
    it('throws if initialize() has not been called', () => {
      expect(() => keyManager.getCurrentKey()).toThrow('not initialized')
    })

    it('returns the active key after initialize()', async () => {
      await keyManager.initialize()
      const key = keyManager.getCurrentKey()
      expect(key.state).toBe('active')
      expect(key.privateKey).toBeDefined()
      expect(key.publicKey).toBeDefined()
    })
  })

  // ── rotate() ──────────────────────────────────────────────────────────────

  describe('rotate()', () => {
    it('throws if called before initialize()', async () => {
      await expect(keyManager.rotate()).rejects.toThrow('not initialized')
    })

    it('creates a new active key', async () => {
      await keyManager.initialize()
      await keyManager.rotate()
      const current = keyManager.getCurrentKey()
      expect(current.state).toBe('active')
    })

    it('retires the previous active key with retiredAt set', async () => {
      await keyManager.initialize()
      const { kid: oldKid } = keyManager.getCurrentKey()
      await keyManager.rotate()
      const allKeys = keyManager.getAllVerificationKeys()
      const retiredKey = allKeys.find((k) => k.kid === oldKid)
      expect(retiredKey).toBeDefined()
      expect(retiredKey!.state).toBe('retired')
      expect(retiredKey!.retiredAt).toBeInstanceOf(Date)
    })

    it('returns { newKid, retiredKid }', async () => {
      await keyManager.initialize()
      const { kid: originalKid } = keyManager.getCurrentKey()
      const result = await keyManager.rotate()
      expect(result.retiredKid).toBe(originalKid)
      expect(result.newKid).not.toBe(originalKid)
    })

    it('new kid differs from retired kid', async () => {
      await keyManager.initialize()
      const { newKid, retiredKid } = await keyManager.rotate()
      expect(newKid).not.toBe(retiredKid)
    })
  })

  // ── getAllVerificationKeys() ───────────────────────────────────────────────

  describe('getAllVerificationKeys()', () => {
    it('returns only the active key before any rotation', async () => {
      await keyManager.initialize()
      const keys = keyManager.getAllVerificationKeys()
      expect(keys).toHaveLength(1)
      expect(keys[0].state).toBe('active')
    })

    it('returns active + retired key immediately after rotation', async () => {
      await keyManager.initialize()
      await keyManager.rotate()
      const keys = keyManager.getAllVerificationKeys()
      expect(keys).toHaveLength(2)
      expect(keys.some((k) => k.state === 'active')).toBe(true)
      expect(keys.some((k) => k.state === 'retired')).toBe(true)
    })
  })

  // ── getPublicJwks() ───────────────────────────────────────────────────────

  describe('getPublicJwks()', () => {
    it('returns { keys: [] } shape', async () => {
      await keyManager.initialize()
      const jwks = await keyManager.getPublicJwks()
      expect(jwks).toHaveProperty('keys')
      expect(Array.isArray(jwks.keys)).toBe(true)
    })

    it('returns one entry after initialize()', async () => {
      await keyManager.initialize()
      const { keys } = await keyManager.getPublicJwks()
      expect(keys).toHaveLength(1)
    })

    it('returns two entries immediately after rotation', async () => {
      await keyManager.initialize()
      await keyManager.rotate()
      const { keys } = await keyManager.getPublicJwks()
      expect(keys).toHaveLength(2)
    })

    it('each JWK has kid, kty, alg, and use === sig', async () => {
      await keyManager.initialize()
      const { keys } = await keyManager.getPublicJwks()
      for (const jwk of keys) {
        expect(jwk.kid).toBeDefined()
        expect(jwk.kty).toBeDefined()
        expect(jwk.alg).toBe('PS256')
        expect(jwk.use).toBe('sig')
      }
    })

    it('does not expose private key material (no d, p, q, dp, dq, qi)', async () => {
      await keyManager.initialize()
      const { keys } = await keyManager.getPublicJwks()
      for (const jwk of keys) {
        expect(jwk).not.toHaveProperty('d')
        expect(jwk).not.toHaveProperty('p')
        expect(jwk).not.toHaveProperty('q')
        expect(jwk).not.toHaveProperty('dp')
        expect(jwk).not.toHaveProperty('dq')
        expect(jwk).not.toHaveProperty('qi')
      }
    })

    it('JWK kid matches the active key kid', async () => {
      await keyManager.initialize()
      const activeKid = keyManager.getCurrentKey().kid
      const { keys } = await keyManager.getPublicJwks()
      expect(keys.some((k) => k.kid === activeKid)).toBe(true)
    })
  })

  // ── signToken() ───────────────────────────────────────────────────────────

  describe('signToken()', () => {
    it('returns a compact JWT string (three dot-separated segments)', async () => {
      await keyManager.initialize()
      const token = await keyManager.signToken({ sub: 'user-1' })
      expect(token.split('.')).toHaveLength(3)
    })

    it('JWT protected header contains kid matching the active key', async () => {
      await keyManager.initialize()
      const activeKid = keyManager.getCurrentKey().kid
      const token = await keyManager.signToken({ sub: 'user-1' })
      const header = decodeProtectedHeader(token)
      expect(header.kid).toBe(activeKid)
    })

    it('JWT protected header contains alg: PS256', async () => {
      await keyManager.initialize()
      const token = await keyManager.signToken({ sub: 'user-1' })
      const header = decodeProtectedHeader(token)
      expect(header.alg).toBe('PS256')
    })

    it('throws if not initialized', async () => {
      await expect(keyManager.signToken({ sub: 'x' })).rejects.toThrow('not initialized')
    })
  })

  // ── verifyToken() ─────────────────────────────────────────────────────────

  describe('verifyToken()', () => {
    it('verifies a token signed with the active key', async () => {
      await keyManager.initialize()
      const token = await keyManager.signToken({ sub: 'user-1' })
      const payload = await keyManager.verifyToken(token)
      expect(payload.sub).toBe('user-1')
    })

    it('rejects a tampered token', async () => {
      await keyManager.initialize()
      const token = await keyManager.signToken({ sub: 'user-1' })
      // Corrupt the signature segment
      const parts = token.split('.')
      parts[2] = parts[2].split('').reverse().join('')
      await expect(keyManager.verifyToken(parts.join('.'))).rejects.toThrow()
    })

    it('rejects a token with unknown kid', async () => {
      await keyManager.initialize()
      const token = await keyManager.signToken({ sub: 'user-1' })
      // Rotate twice so the original key is pruned
      keyManager._resetStore()
      await keyManager.initialize()
      await expect(keyManager.verifyToken(token)).rejects.toThrow(/Unknown or expired signing key/)
    })

    it('rejects a JWT with no kid in header', async () => {
      // Build a token without kid manually using jose
      const { generateKeyPair, SignJWT } = await import('jose')
      const { privateKey } = await generateKeyPair('PS256', { modulusLength: 2048 })
      const token = await new SignJWT({ sub: 'test' })
        .setProtectedHeader({ alg: 'PS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey)

      await keyManager.initialize()
      await expect(keyManager.verifyToken(token)).rejects.toThrow(/missing kid/)
    })
  })

  // ── Audit log ─────────────────────────────────────────────────────────────

  describe('getAuditLog()', () => {
    it('records KEY_CREATED on initialize()', async () => {
      await keyManager.initialize()
      const log = keyManager.getAuditLog()
      expect(log).toHaveLength(1)
      expect(log[0].event).toBe('KEY_CREATED')
      expect(log[0].kid).toBeDefined()
      expect(log[0].timestamp).toBeDefined()
    })

    it('records KEY_RETIRED and KEY_ROTATED on rotate()', async () => {
      await keyManager.initialize()
      await keyManager.rotate()
      const log = keyManager.getAuditLog()
      const events = log.map((e) => e.event)
      expect(events).toContain('KEY_RETIRED')
      expect(events).toContain('KEY_ROTATED')
    })

    it('KEY_ROTATED event has previousActiveKid set', async () => {
      await keyManager.initialize()
      const originalKid = keyManager.getCurrentKey().kid
      await keyManager.rotate()
      const rotatedEvent = keyManager.getAuditLog().find((e) => e.event === 'KEY_ROTATED')
      expect(rotatedEvent?.previousActiveKid).toBe(originalKid)
    })

    it('returns a copy — mutations do not affect internal state', async () => {
      await keyManager.initialize()
      const log1 = keyManager.getAuditLog()
      log1.push({ event: 'KEY_PRUNED', kid: 'fake', timestamp: '' })
      const log2 = keyManager.getAuditLog()
      expect(log2).toHaveLength(1)
    })
  })

  // ── _resetStore() ─────────────────────────────────────────────────────────

  describe('_resetStore()', () => {
    it('clears all keys', async () => {
      await keyManager.initialize()
      keyManager._resetStore()
      expect(() => keyManager.getCurrentKey()).toThrow('not initialized')
    })

    it('clears the audit log', async () => {
      await keyManager.initialize()
      keyManager._resetStore()
      expect(keyManager.getAuditLog()).toHaveLength(0)
    })
  })
})

// ── Rotation boundary tests (custom grace window via fresh instance) ──────────

describe('KeyManager — rotation boundary tests', () => {
  it('token signed before rotation verifies during grace period', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 3600, clockSkewSeconds: 300 })
    await mgr.initialize()
    const tokenBeforeRotation = await mgr.signToken({ sub: 'user-1' })

    await mgr.rotate()

    // Old token should still verify — retired key is within grace window
    const payload = await mgr.verifyToken(tokenBeforeRotation)
    expect(payload.sub).toBe('user-1')
  })

  it('token signed with new key after rotation verifies', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 3600, clockSkewSeconds: 300 })
    await mgr.initialize()
    await mgr.rotate()
    const newToken = await mgr.signToken({ sub: 'user-2' })
    const payload = await mgr.verifyToken(newToken)
    expect(payload.sub).toBe('user-2')
  })

  it('both old and new tokens verify immediately after rotation', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 3600, clockSkewSeconds: 300 })
    await mgr.initialize()
    const oldToken = await mgr.signToken({ sub: 'old' })
    await mgr.rotate()
    const newToken = await mgr.signToken({ sub: 'new' })

    const [oldPayload, newPayload] = await Promise.all([
      mgr.verifyToken(oldToken),
      mgr.verifyToken(newToken),
    ])
    expect(oldPayload.sub).toBe('old')
    expect(newPayload.sub).toBe('new')
  })
})

// ── pruneExpiredKeys() tests (fake timers) ────────────────────────────────────

describe('KeyManager — pruneExpiredKeys()', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not prune a retired key within the grace + skew window', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 60, clockSkewSeconds: 10 })
    await mgr.initialize()
    const { retiredKid } = await mgr.rotate()

    // Advance 30 s (well within the 70 s window)
    vi.useFakeTimers()
    vi.advanceTimersByTime(30_000)

    const pruned = mgr.pruneExpiredKeys()
    expect(pruned).toHaveLength(0)
    const verifyKeys = mgr.getAllVerificationKeys()
    expect(verifyKeys.some((k) => k.kid === retiredKid)).toBe(true)

    vi.useRealTimers()
  })

  it('prunes a retired key after grace + skew window has elapsed', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 60, clockSkewSeconds: 10 })
    await mgr.initialize()
    const { retiredKid } = await mgr.rotate()

    vi.useFakeTimers()
    // Advance 71 s — just past the 70 s (60 + 10) window
    vi.advanceTimersByTime(71_000)

    const pruned = mgr.pruneExpiredKeys()
    expect(pruned).toContain(retiredKid)

    const verifyKeys = mgr.getAllVerificationKeys()
    expect(verifyKeys.some((k) => k.kid === retiredKid)).toBe(false)

    vi.useRealTimers()
  })

  it('emits KEY_PRUNED audit event for each pruned key', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 60, clockSkewSeconds: 10 })
    await mgr.initialize()
    const { retiredKid } = await mgr.rotate()

    vi.useFakeTimers()
    vi.advanceTimersByTime(71_000)

    mgr.pruneExpiredKeys()

    const pruneEvents = mgr.getAuditLog().filter((e) => e.event === 'KEY_PRUNED')
    expect(pruneEvents.some((e) => e.kid === retiredKid)).toBe(true)

    vi.useRealTimers()
  })

  it('old token fails verification after its key is pruned', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 60, clockSkewSeconds: 10 })
    await mgr.initialize()
    const oldToken = await mgr.signToken({ sub: 'user-1' }, '2h')
    await mgr.rotate()

    vi.useFakeTimers()
    vi.advanceTimersByTime(71_000)
    mgr.pruneExpiredKeys()

    await expect(mgr.verifyToken(oldToken)).rejects.toThrow(/Unknown or expired signing key/)

    vi.useRealTimers()
  })

  it('returns array of pruned kids', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 60, clockSkewSeconds: 10 })
    await mgr.initialize()
    const { retiredKid } = await mgr.rotate()

    vi.useFakeTimers()
    vi.advanceTimersByTime(71_000)

    const pruned = mgr.pruneExpiredKeys()
    expect(pruned).toEqual(expect.arrayContaining([retiredKid]))

    vi.useRealTimers()
  })
})

// ── PEM key loading tests ─────────────────────────────────────────────────────

describe('KeyManager — initialize() with privateKeyPem', () => {
  let testPem: string

  beforeAll(async () => {
    const { generateKeyPair, exportPKCS8 } = await import('jose')
    const { privateKey } = await generateKeyPair('PS256', { modulusLength: 2048, extractable: true })
    testPem = await exportPKCS8(privateKey)
  })

  it('loads key from PEM instead of generating a new one', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 3600, clockSkewSeconds: 300, privateKeyPem: testPem })
    await mgr.initialize()
    const key = mgr.getCurrentKey()
    expect(key.state).toBe('active')
    expect(key.privateKey).toBeDefined()
    expect(key.publicKey).toBeDefined()
  })

  it('uses initialKid when provided alongside privateKeyPem', async () => {
    const mgr = new KeyManager({
      gracePeriodSeconds: 3600,
      clockSkewSeconds: 300,
      privateKeyPem: testPem,
      initialKid: 'my-stable-kid-v1',
    })
    await mgr.initialize()
    expect(mgr.getCurrentKey().kid).toBe('my-stable-kid-v1')
  })

  it('assigns a random UUID kid when initialKid is not provided', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 3600, clockSkewSeconds: 300, privateKeyPem: testPem })
    await mgr.initialize()
    expect(mgr.getCurrentKey().kid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('can sign and verify tokens after loading from PEM', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 3600, clockSkewSeconds: 300, privateKeyPem: testPem })
    await mgr.initialize()
    const token = await mgr.signToken({ sub: 'pem-user' })
    const payload = await mgr.verifyToken(token)
    expect(payload.sub).toBe('pem-user')
  })

  it('does not expose private key material in JWKS after PEM load', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 3600, clockSkewSeconds: 300, privateKeyPem: testPem })
    await mgr.initialize()
    const { keys } = await mgr.getPublicJwks()
    for (const jwk of keys) {
      expect(jwk).not.toHaveProperty('d')
      expect(jwk).not.toHaveProperty('p')
      expect(jwk).not.toHaveProperty('q')
    }
  })

  it('emits KEY_CREATED audit event when loading from PEM', async () => {
    const mgr = new KeyManager({ gracePeriodSeconds: 3600, clockSkewSeconds: 300, privateKeyPem: testPem })
    await mgr.initialize()
    const log = mgr.getAuditLog()
    expect(log).toHaveLength(1)
    expect(log[0].event).toBe('KEY_CREATED')
  })

  it('is idempotent — second initialize() call is a no-op even with PEM', async () => {
    const mgr = new KeyManager({
      gracePeriodSeconds: 3600,
      clockSkewSeconds: 300,
      privateKeyPem: testPem,
      initialKid: 'stable-kid',
    })
    await mgr.initialize()
    await mgr.initialize()
    expect(mgr.getAllVerificationKeys()).toHaveLength(1)
    expect(mgr.getCurrentKey().kid).toBe('stable-kid')
  })

  it('rotation still works after PEM-loaded key', async () => {
    const mgr = new KeyManager({
      gracePeriodSeconds: 3600,
      clockSkewSeconds: 300,
      privateKeyPem: testPem,
      initialKid: 'pem-key',
    })
    await mgr.initialize()
    const { retiredKid, newKid } = await mgr.rotate()
    expect(retiredKid).toBe('pem-key')
    expect(newKid).not.toBe('pem-key')
    expect(mgr.getCurrentKey().state).toBe('active')
  })
})
