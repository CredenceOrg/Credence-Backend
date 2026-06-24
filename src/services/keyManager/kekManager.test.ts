import { describe, it, expect, vi, afterEach } from 'vitest'
import crypto from 'crypto'
import { KekManager, kekManager, generateKekMaterial } from './index.js'

function freshManager(): KekManager {
  return new KekManager()
}

function encrypt(plaintext: string, keyMaterial: Buffer) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyMaterial, iv)
  let blob = cipher.update(plaintext, 'utf8', 'hex')
  blob += cipher.final('hex')
  return { blob, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') }
}

function decrypt(
  enc: { blob: string; iv: string; authTag: string },
  keyMaterial: Buffer,
): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyMaterial, Buffer.from(enc.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(enc.authTag, 'hex'))
  let plaintext = decipher.update(enc.blob, 'hex', 'utf8')
  plaintext += decipher.final('utf8')
  return plaintext
}

describe('KekManager.registerVersion()', () => {
  it('auto-activates the very first registered version', () => {
    const km = freshManager()
    const result = km.registerVersion(crypto.randomBytes(32))
    expect(result.version).toBe(1)
    expect(result.autoActivated).toBe(true)
    expect(km.getCurrentKek().version).toBe(1)
    expect(km.getCurrentKek().state).toBe('active')
  })

  it('does NOT auto-activate the second version — stays retired (pending)', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    const result = km.registerVersion(crypto.randomBytes(32))
    expect(result.version).toBe(2)
    expect(result.autoActivated).toBe(false)
    expect(km.getCurrentKek().version).toBe(1)
  })

  it('increments version numbers monotonically', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    const r3 = km.registerVersion(crypto.randomBytes(32))
    expect(r3.version).toBe(3)
  })

  it('rejects key material that is not exactly 32 bytes (garbled key)', () => {
    const km = freshManager()
    expect(() => km.registerVersion(crypto.randomBytes(16))).toThrow(/32 bytes/)
    expect(() => km.registerVersion(crypto.randomBytes(33))).toThrow(/32 bytes/)
    expect(() => km.registerVersion(Buffer.alloc(0))).toThrow(/32 bytes/)
  })

  it('copies key material into its own buffer (mutating the caller buffer does not affect internal state)', () => {
    const km = freshManager()
    const original = crypto.randomBytes(32)
    const snapshot = Buffer.from(original)
    km.registerVersion(original)

    original.fill(0xff)

    expect(km.getCurrentKek().keyMaterial.equals(snapshot)).toBe(true)
  })

  it('emits KEK_REGISTERED, and KEK_ACTIVATED only when auto-activated', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))

    const events = km.getAuditLog().map((e) => `${e.event}:${e.version}`)
    expect(events).toContain('KEK_REGISTERED:1')
    expect(events).toContain('KEK_ACTIVATED:1')
    expect(events).toContain('KEK_REGISTERED:2')
    expect(events).not.toContain('KEK_ACTIVATED:2')
  })
})

describe('KekManager.approveActivation()', () => {
  it('throws for an unregistered version', () => {
    const km = freshManager()
    expect(() => km.approveActivation(99, 'alice')).toThrow(/not found/)
  })

  it('throws if the version is already active', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    expect(() => km.approveActivation(1, 'alice')).toThrow(/already active/)
  })

  it('records distinct approvers', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    expect(km.getPendingApprovals(2)).toHaveLength(2)
  })

  it('rejects the same approver approving twice', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    expect(() => km.approveActivation(2, 'alice')).toThrow(/already approved/)
  })
})

describe('KekManager.activateVersion()', () => {
  it('throws for an unregistered version', () => {
    const km = freshManager()
    expect(() => km.activateVersion(99)).toThrow(/not found/)
  })

  it('throws if already active', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    expect(() => km.activateVersion(1)).toThrow(/already active/)
  })

  it('throws when approvals are below the required threshold (interrupted/incomplete rotation)', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')

    expect(() => km.activateVersion(2)).toThrow(
      new RegExp(`requires ${KekManager.REQUIRED_APPROVALS} approvals`),
    )

    expect(km.getCurrentKek().version).toBe(1)
    expect(km.getVersion(2).state).toBe('retired')
  })

  it('activates with the required number of distinct approvals', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')

    expect(() => km.activateVersion(2)).not.toThrow()
    expect(km.getCurrentKek().version).toBe(2)
  })

  it('retires the previously active version with retiredAt set', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)

    const v1 = km.getVersion(1)
    expect(v1.state).toBe('retired')
    expect(v1.retiredAt).toBeInstanceOf(Date)
  })

  it('rotation is atomic: immediately after activation, new key is active AND old key material is still intact (no invalid window)', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)

    expect(km.getCurrentKek().version).toBe(2)
    expect(km.getCurrentKek().state).toBe('active')
    expect(km.getVersion(1).keyMaterial.length).toBe(32)
    expect(km.getVersion(1).keyMaterial.every((b) => b === 0)).toBe(false)
  })

  it('emits KEK_RETIRED for the old version and KEK_ACTIVATED with previousVersion for the new one', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)

    const log = km.getAuditLog()
    expect(log.some((e) => e.event === 'KEK_RETIRED' && e.version === 1)).toBe(true)
    const activated = log.find((e) => e.event === 'KEK_ACTIVATED' && e.version === 2)
    expect(activated?.previousVersion).toBe(1)
  })
})

describe('KekManager — overlap-window decryptability', () => {
  it('data encrypted under key N decrypts after rotating to N+1', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))

    const enc = encrypt('sensitive evidence payload', km.getCurrentKek().keyMaterial)

    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)

    const plaintext = decrypt(enc, km.getVersion(1).keyMaterial)
    expect(plaintext).toBe('sensitive evidence payload')
  })

  it('new data encrypted under the new active key decrypts correctly too', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)

    const enc = encrypt('new evidence', km.getCurrentKek().keyMaterial)
    expect(decrypt(enc, km.getVersion(2).keyMaterial)).toBe('new evidence')
  })

  it('multiple rotations: data from v1 still decryptable with v1 material after rotating to v3', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    const enc = encrypt('v1 data', km.getCurrentKek().keyMaterial)

    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)

    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(3, 'alice')
    km.approveActivation(3, 'bob')
    km.activateVersion(3)

    expect(km.getCurrentKek().version).toBe(3)
    expect(decrypt(enc, km.getVersion(1).keyMaterial)).toBe('v1 data')
  })
})

describe('KekManager.zeroizeRetired()', () => {
  it('zeroizes all bytes of retired key material (not just a prefix)', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)

    km.zeroizeRetired()

    const v1 = km.getVersion(1)
    expect(v1.keyMaterial.every((b) => b === 0)).toBe(true)
  })

  it('does not touch the active key material', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)

    km.zeroizeRetired()

    expect(km.getCurrentKek().keyMaterial.every((b) => b === 0)).toBe(false)
  })

  it('returns the list of zeroized version numbers and emits KEK_ZEROIZED', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)

    const zeroized = km.zeroizeRetired()
    expect(zeroized).toEqual([1])
    expect(km.getAuditLog().some((e) => e.event === 'KEK_ZEROIZED' && e.version === 1)).toBe(true)
  })

  it('a zeroized (revoked) key can no longer decrypt previously-encrypted data', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    const enc = encrypt('will become unreadable', km.getCurrentKek().keyMaterial)

    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)
    km.zeroizeRetired()

    expect(() => decrypt(enc, km.getVersion(1).keyMaterial)).toThrow()
  })

  it('returns an empty array when there is nothing retired to zeroize', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    expect(km.zeroizeRetired()).toEqual([])
  })
})

describe('KekManager — lookups', () => {
  it('getCurrentKek() throws when nothing has been registered', () => {
    const km = freshManager()
    expect(() => km.getCurrentKek()).toThrow(/No active KEK/)
  })

  it('getVersion() throws for a version that was never registered', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    expect(() => km.getVersion(404)).toThrow(/not found/)
  })

  it('getAllVersions() returns both active and retired versions', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)

    const all = km.getAllVersions()
    expect(all).toHaveLength(2)
    expect(all.some((k) => k.state === 'active')).toBe(true)
    expect(all.some((k) => k.state === 'retired')).toBe(true)
  })
})

describe('KekManager — defensive copies', () => {
  it('getPendingApprovals() returns a copy; mutating it does not affect internal state', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    const approvals = km.getPendingApprovals(2)
    approvals.push({ version: 2, approvedBy: 'fake-injected', approvedAt: new Date() })

    expect(km.getPendingApprovals(2)).toHaveLength(1)
  })

  it('getAuditLog() returns a copy; mutating it does not affect internal state', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))

    const log = km.getAuditLog()
    const lenBefore = log.length
    log.push({ timestamp: '', event: 'KEK_ZEROIZED', version: 999 })

    expect(km.getAuditLog()).toHaveLength(lenBefore)
  })
})

describe('KekManager — secret material never logged', () => {
  let logSpy: ReturnType<typeof vi.spyOn> | undefined
  let errorSpy: ReturnType<typeof vi.spyOn> | undefined

  afterEach(() => {
    logSpy?.mockRestore()
    errorSpy?.mockRestore()
  })

  it('does not call console.log or console.error during a full rotation + zeroize lifecycle', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)
    km.zeroizeRetired()

    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('audit log entries never contain raw key material', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')
    km.approveActivation(2, 'bob')
    km.activateVersion(2)
    km.zeroizeRetired()

    for (const event of km.getAuditLog()) {
      expect(event).not.toHaveProperty('keyMaterial')
      expect(JSON.stringify(event)).not.toMatch(/[0-9a-f]{64}/i)
    }
  })
})

describe('KekManager._resetStore()', () => {
  it('zeroizes all key material (including the active key) before clearing', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    const materialRef = km.getCurrentKek().keyMaterial

    km._resetStore()

    expect(materialRef.every((b) => b === 0)).toBe(true)
  })

  it('clears versions, approvals, current version, and audit log', () => {
    const km = freshManager()
    km.registerVersion(crypto.randomBytes(32))
    km.registerVersion(crypto.randomBytes(32))
    km.approveActivation(2, 'alice')

    km._resetStore()

    expect(km.getAllVersions()).toHaveLength(0)
    expect(km.getAuditLog()).toHaveLength(0)
    expect(km.getPendingApprovals(2)).toEqual([])
    expect(() => km.getCurrentKek()).toThrow(/No active KEK/)
  })
})

describe('generateKekMaterial()', () => {
  it('returns different material on each call', () => {
    const a = generateKekMaterial()
    const b = generateKekMaterial()
    expect(a.equals(b)).toBe(false)
  })

  it('is directly usable with registerVersion()', () => {
    const km = freshManager()
    expect(() => km.registerVersion(generateKekMaterial())).not.toThrow()
  })
})

describe('kekManager (singleton)', () => {
  it('is an instance of KekManager', () => {
    expect(kekManager).toBeInstanceOf(KekManager)
  })
})
