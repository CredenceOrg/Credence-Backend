import { generateKeyPair, exportJWK, SignJWT, jwtVerify, decodeProtectedHeader, importPKCS8 } from 'jose'
import { randomUUID } from 'crypto'
import type { KeyLike } from 'jose'
import type { ManagedKey, JwksResponse, KeyManagerConfig, KeyAuditEvent } from './types.js'

const ALG = 'PS256'

/**
 * Manages RSA signing key pairs for JWT issuance and verification.
 *
 * Keys progress through two states:
 *  - `active`  — the current signing key; used for all new JWTs.
 *  - `retired` — a recently rotated key kept alive for grace-period verification.
 *
 * After `gracePeriodSeconds + clockSkewSeconds` have elapsed since retirement,
 * a key is hard-pruned and can no longer verify any token.
 *
 * ## Clock skew
 * `clockSkewSeconds` (default 300 s) is passed as `clockTolerance` to every
 * `jwtVerify()` call, tolerating tokens whose `exp` or `iat` are slightly off
 * due to clock drift between issuer and verifier. The same value is added to the
 * grace window so a key is never pruned while tokens it signed could still be
 * within the tolerance window of any verifier.
 */
export class KeyManager {
  private readonly keys: Map<string, ManagedKey> = new Map()
  private activeKid: string | null = null
  private readonly config: KeyManagerConfig
  private readonly auditLog: KeyAuditEvent[] = []

  constructor(config: KeyManagerConfig) {
    this.config = config
  }

  // ── Initialization ──────────────────────────────────────────────────────

  /**
   * Generate (or import) the initial active key pair.
   * Idempotent — calling more than once is a no-op.
   * When `config.privateKeyPem` is set the PEM is imported instead of generating a new key.
   */
  async initialize(): Promise<void> {
    if (this.activeKid !== null) return
    const key = this.config.privateKeyPem
      ? await this._importKey(this.config.privateKeyPem, this.config.initialKid)
      : await this._generateKey()
    this._emitAudit({ timestamp: new Date().toISOString(), event: 'KEY_CREATED', kid: key.kid })
  }

  // ── Key Accessors ────────────────────────────────────────────────────────

  /**
   * Returns the currently active `ManagedKey`.
   * @throws {Error} if `initialize()` has not been called.
   */
  getCurrentKey(): ManagedKey {
    if (this.activeKid === null) {
      throw new Error('KeyManager not initialized — call initialize() first')
    }
    return this.keys.get(this.activeKid)!
  }

  /**
   * Returns all keys eligible for JWT verification: the active key plus any
   * retired keys still within their grace + clock-skew window.
   */
  getAllVerificationKeys(): ManagedKey[] {
    const now = Date.now()
    const windowMs = (this.config.gracePeriodSeconds + this.config.clockSkewSeconds) * 1000

    return [...this.keys.values()].filter((k) => {
      if (k.state === 'active') return true
      // retired: keep while still within grace + skew window
      return k.retiredAt !== null && now - k.retiredAt.getTime() < windowMs
    })
  }

  // ── Rotation ─────────────────────────────────────────────────────────────

  /**
   * Rotate the signing key:
   *  1. Retires the current active key (sets `retiredAt`, state → `retired`).
   *  2. Generates a new active key pair.
   *  3. Prunes keys that have passed their grace + skew deadline.
   *
   * @returns The new and previous key identifiers.
   * @throws {Error} if not initialized.
   */
  async rotate(): Promise<{ newKid: string; retiredKid: string }> {
    const previous = this.getCurrentKey()
    const retiredKid = previous.kid

    // Retire previous active key
    previous.state = 'retired'
    previous.retiredAt = new Date()
    this._emitAudit({
      timestamp: previous.retiredAt.toISOString(),
      event: 'KEY_RETIRED',
      kid: retiredKid,
    })

    // Generate and activate new key
    const newKey = await this._generateKey()
    this._emitAudit({
      timestamp: new Date().toISOString(),
      event: 'KEY_ROTATED',
      kid: newKey.kid,
      previousActiveKid: retiredKid,
    })

    this.pruneExpiredKeys()

    return { newKid: newKey.kid, retiredKid }
  }

  /**
   * Remove keys whose retirement window (grace + clock skew) has fully elapsed.
   *
   * @returns Array of pruned `kid` values.
   */
  pruneExpiredKeys(): string[] {
    const now = Date.now()
    const windowMs = (this.config.gracePeriodSeconds + this.config.clockSkewSeconds) * 1000
    const pruned: string[] = []

    for (const [kid, key] of this.keys) {
      if (
        key.state === 'retired' &&
        key.retiredAt !== null &&
        now - key.retiredAt.getTime() >= windowMs
      ) {
        this.keys.delete(kid)
        pruned.push(kid)
        this._emitAudit({
          timestamp: new Date().toISOString(),
          event: 'KEY_PRUNED',
          kid,
        })
      }
    }

    return pruned
  }

  // ── JWK Endpoint Support ─────────────────────────────────────────────────

  /**
   * Returns the JWK Set containing public keys for signature verification.
   * Includes the active key and all retired keys still within grace period.
   * Private key material (`d`, `p`, `q`, `dp`, `dq`, `qi`) is never included.
   */
  async getPublicJwks(): Promise<JwksResponse> {
    const verificationKeys = this.getAllVerificationKeys()
    const jwkEntries = await Promise.all(
      verificationKeys.map(async (k) => {
        const jwk = await exportJWK(k.publicKey)
        // Annotate with required JWKS metadata
        return {
          ...jwk,
          kid: k.kid,
          alg: ALG,
          use: 'sig',
        } as JsonWebKey
      }),
    )
    return { keys: jwkEntries }
  }

  // ── JWT Operations ────────────────────────────────────────────────────────

  /**
   * Sign a JWT payload with the current active key.
   *
   * The protected header includes:
   *  - `alg: PS256`
   *  - `kid`: the active key's identifier
   *
   * @param payload   Claims to embed in the token body.
   * @param expiresIn Expiry string (e.g. `'1h'`, `'15m'`). Defaults to `'1h'`.
   * @returns Compact serialised JWT string.
   * @throws {Error} if not initialized.
   */
  async signToken(
    payload: Record<string, unknown>,
    expiresIn: string = '1h',
  ): Promise<string> {
    const { kid, privateKey } = this.getCurrentKey()
    return new SignJWT(payload)
      .setProtectedHeader({ alg: ALG, kid })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey as KeyLike)
  }

  /**
   * Verify a JWT against all currently valid keys (active + grace-period retired).
   *
   * Extracts `kid` from the protected header for O(1) key lookup, then calls
   * `jwtVerify` with `clockTolerance` set to `clockSkewSeconds`.
   *
   * @returns Verified JWT payload.
   * @throws {Error} with a descriptive message for unknown `kid`, expired keys,
   *                 invalid signatures, or expired tokens.
   */
  async verifyToken(token: string): Promise<Record<string, unknown>> {
    let kid: string | undefined
    try {
      const header = decodeProtectedHeader(token)
      kid = header.kid
    } catch {
      throw new Error('Invalid JWT: unable to decode protected header')
    }

    if (!kid) {
      throw new Error('Invalid JWT: missing kid in header')
    }

    const verificationKeys = this.getAllVerificationKeys()
    const managedKey = verificationKeys.find((k) => k.kid === kid)

    if (!managedKey) {
      throw new Error(`Unknown or expired signing key: kid=${kid}`)
    }

    const { payload } = await jwtVerify(token, managedKey.publicKey as KeyLike, {
      clockTolerance: this.config.clockSkewSeconds,
    })

    return payload as Record<string, unknown>
  }

  // ── Audit ────────────────────────────────────────────────────────────────

  /** Returns a copy of all audit events recorded since initialization (or last reset). */
  getAuditLog(): KeyAuditEvent[] {
    return [...this.auditLog]
  }

  // ── Test Isolation ────────────────────────────────────────────────────────

  /** Reset all in-memory state. Intended for use in tests only. */
  _resetStore(): void {
    this.keys.clear()
    this.activeKid = null
    this.auditLog.length = 0
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private async _generateKey(): Promise<ManagedKey> {
    const { privateKey, publicKey } = await generateKeyPair(ALG, { modulusLength: 2048 })
    const kid = randomUUID()
    const managed: ManagedKey = {
      kid,
      state: 'active',
      privateKey,
      publicKey,
      createdAt: new Date(),
      retiredAt: null,
    }
    this.keys.set(kid, managed)
    this.activeKid = kid
    return managed
  }

  private async _importKey(pem: string, kid?: string): Promise<ManagedKey> {
    const { createPublicKey } = await import('crypto')
    const privateKey = await importPKCS8(pem, ALG)
    // Derive the public key from the imported private key via Node's crypto module
    const publicKey = createPublicKey(pem)
    const resolvedKid = kid ?? randomUUID()
    const managed: ManagedKey = {
      kid: resolvedKid,
      state: 'active',
      privateKey,
      publicKey,
      createdAt: new Date(),
      retiredAt: null,
    }
    this.keys.set(resolvedKid, managed)
    this.activeKid = resolvedKid
    return managed
  }

  private _emitAudit(event: KeyAuditEvent): void {
    this.auditLog.push(event)
    console.log(JSON.stringify(event))
  }
}

/**
 * Application-wide singleton KeyManager.
 * Call `await keyManager.initialize()` once at server startup before serving traffic.
 * In tests, call `keyManager._resetStore()` in `beforeEach` for isolation.
 */
export const keyManager = new KeyManager({
  gracePeriodSeconds: Number(process.env.KEY_GRACE_PERIOD_SECONDS ?? '3600'),
  clockSkewSeconds: Number(process.env.KEY_CLOCK_SKEW_SECONDS ?? '300'),
  privateKeyPem: process.env.KEY_PRIVATE_PEM,
  initialKid: process.env.KEY_INITIAL_KID,
})
