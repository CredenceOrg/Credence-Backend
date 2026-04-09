import type { KeyLike } from 'jose'

export type KeyState = 'active' | 'retired'

/** A managed RSA key pair with lifecycle metadata. */
export interface ManagedKey {
  /** UUID v4 key identifier — embedded in JWT `kid` protected header. */
  kid: string
  state: KeyState
  privateKey: KeyLike
  publicKey: KeyLike
  createdAt: Date
  /** Set when the key transitions from active to retired. Null while active. */
  retiredAt: Date | null
}

/** Shape of the `/.well-known/jwks.json` response body. */
export interface JwksResponse {
  keys: JsonWebKey[]
}

/** Configuration for a KeyManager instance. */
export interface KeyManagerConfig {
  /** Seconds a retired key remains valid for JWT verification after rotation. */
  gracePeriodSeconds: number
  /**
   * Extra tolerance (seconds) added to the grace window before hard-pruning a key.
   * Also passed as `clockTolerance` to jwtVerify() to tolerate slightly-fast issuer clocks.
   * Default: 300 (5 minutes).
   */
  clockSkewSeconds: number
  /**
   * Optional PKCS8 PEM-encoded RSA private key to import as the initial signing key.
   * When set, `initialize()` imports this key instead of generating a fresh one,
   * ensuring tokens remain valid across restarts.
   */
  privateKeyPem?: string
  /**
   * Optional stable `kid` to assign to the key loaded from `privateKeyPem`.
   * When omitted a random UUID v4 is used.
   */
  initialKid?: string
}

/** Structured audit event emitted on every key state transition. */
export interface KeyAuditEvent {
  /** ISO-8601 timestamp of the transition. */
  timestamp: string
  event: 'KEY_CREATED' | 'KEY_ROTATED' | 'KEY_RETIRED' | 'KEY_PRUNED'
  /** The kid of the key whose state changed. */
  kid: string
  /** The kid of the key that was active before a rotation. Present on KEY_ROTATED. */
  previousActiveKid?: string
}
