import type { KeyObject } from 'node:crypto'

export type KeyLike = CryptoKey | KeyObject

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

// ── KEK (Key Encryption Key) types ──────────────────────────────────────────

/** State of a KEK version. */
export type KekState = 'active' | 'retired'

/**
 * A versioned Key Encryption Key used for envelope-encrypting evidence at rest.
 * The raw key material is a 32-byte AES-256 key.
 */
export interface KekVersion {
  /** Monotonically increasing integer version number (1, 2, 3, …). */
  version: number
  /** AES-256 key material (32 bytes). Zeroized after re-encryption completes. */
  keyMaterial: Buffer
  state: KekState
  createdAt: Date
  /** Set when this version is superseded by a newer one. */
  retiredAt: Date | null
}

/** Audit event for KEK lifecycle transitions. */
export interface KekAuditEvent {
  timestamp: string
  event: 'KEK_REGISTERED' | 'KEK_ACTIVATED' | 'KEK_RETIRED' | 'KEK_ZEROIZED'
  version: number
  /** Version that was previously active (present on KEK_ACTIVATED). */
  previousVersion?: number
}

/** Result of registering a new KEK version (dual-control approval). */
export interface KekRegistrationResult {
  version: number
  /** True when the new version is immediately active (no prior active version). */
  autoActivated: boolean
}

/** Dual-control approval record required before activating a new KEK. */
export interface KekApproval {
  version: number
  approvedBy: string
  approvedAt: Date
}
