import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

/**
 * Supported JWT token types.
 */
export type TokenType = 'access' | 'refresh'

/**
 * Claims stored in Credence JWTs.
 */
export interface JwtClaims {
  iss: string
  sub: string
  exp: number
  iat: number
  type: TokenType
  jti?: string
}

/**
 * Configuration for JWT issuance and validation.
 */
export interface AuthConfig {
  issuer: string
  accessTokenSecret: string
  refreshTokenSecret: string
  accessTokenExpiry: string | number
  refreshTokenExpiry: string | number
  clockToleranceSeconds?: number
}

/**
 * Access/refresh token pair response.
 */
export interface TokenPair {
  accessToken: string
  refreshToken: string
  accessTokenExpiresInSeconds: number
  refreshTokenExpiresInSeconds: number
}

/**
 * Error type used by authentication flows.
 */
export class AuthError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_TOKEN'
      | 'INVALID_SIGNATURE'
      | 'INVALID_CLAIMS'
      | 'TOKEN_EXPIRED'
      | 'UNSUPPORTED_TOKEN',
    message: string
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

interface JwtHeader {
  alg: 'HS256'
  typ: 'JWT'
}

const ACCESS_TOKEN_TYPE: TokenType = 'access'
const REFRESH_TOKEN_TYPE: TokenType = 'refresh'

/**
 * Creates and validates JWT tokens for the API gateway.
 */
export class AuthService {
  private readonly accessTokenExpirySeconds: number
  private readonly refreshTokenExpirySeconds: number
  private readonly clockToleranceSeconds: number

  constructor(private readonly config: AuthConfig = getAuthConfigFromEnv()) {
    this.accessTokenExpirySeconds = parseExpiryToSeconds(config.accessTokenExpiry)
    this.refreshTokenExpirySeconds = parseExpiryToSeconds(config.refreshTokenExpiry)
    this.clockToleranceSeconds = config.clockToleranceSeconds ?? 0
  }

  /**
   * Issues a new access and refresh token pair for a subject.
   */
  issueTokenPair(subject: string): TokenPair {
    if (!subject || typeof subject !== 'string') {
      throw new AuthError('INVALID_CLAIMS', 'subject (sub) is required')
    }

    return {
      accessToken: this.issueToken(subject, ACCESS_TOKEN_TYPE, this.accessTokenExpirySeconds),
      refreshToken: this.issueToken(subject, REFRESH_TOKEN_TYPE, this.refreshTokenExpirySeconds),
      accessTokenExpiresInSeconds: this.accessTokenExpirySeconds,
      refreshTokenExpiresInSeconds: this.refreshTokenExpirySeconds,
    }
  }

  /**
   * Verifies an access token and returns validated claims.
   */
  verifyAccessToken(token: string): JwtClaims {
    return this.verifyToken(token, ACCESS_TOKEN_TYPE)
  }

  /**
   * Verifies a refresh token and returns validated claims.
   */
  verifyRefreshToken(token: string): JwtClaims {
    return this.verifyToken(token, REFRESH_TOKEN_TYPE)
  }

  /**
   * Validates a refresh token and rotates into a new token pair.
   */
  refreshToken(refreshToken: string): TokenPair {
    const claims = this.verifyRefreshToken(refreshToken)
    return this.issueTokenPair(claims.sub)
  }

  private issueToken(subject: string, type: TokenType, expiresInSeconds: number): string {
    const now = nowInSeconds()
    const header: JwtHeader = { alg: 'HS256', typ: 'JWT' }
    const payload: JwtClaims = {
      iss: this.config.issuer,
      sub: subject,
      iat: now,
      exp: now + expiresInSeconds,
      type,
      jti: randomUUID(),
    }

    const encodedHeader = encodeBase64Url(JSON.stringify(header))
    const encodedPayload = encodeBase64Url(JSON.stringify(payload))
    const signingInput = `${encodedHeader}.${encodedPayload}`
    const signature = sign(signingInput, this.getSecretForType(type))

    return `${signingInput}.${signature}`
  }

  private verifyToken(token: string, expectedType: TokenType): JwtClaims {
    if (!token || typeof token !== 'string') {
      throw new AuthError('INVALID_TOKEN', 'token is required')
    }

    const tokenParts = token.split('.')
    if (tokenParts.length !== 3) {
      throw new AuthError('INVALID_TOKEN', 'token format must be header.payload.signature')
    }

    const [encodedHeader, encodedPayload, signature] = tokenParts
    const signingInput = `${encodedHeader}.${encodedPayload}`

    const header = decodeTokenPart<JwtHeader>(encodedHeader, 'JWT header')
    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      throw new AuthError('INVALID_TOKEN', 'unsupported JWT header')
    }

    const payload = decodeTokenPart<JwtClaims>(encodedPayload, 'JWT payload')
    const expectedSignature = sign(signingInput, this.getSecretForType(expectedType))

    if (!safeCompare(signature, expectedSignature)) {
      throw new AuthError('INVALID_SIGNATURE', 'invalid token signature')
    }

    this.validateClaims(payload, expectedType)
    return payload
  }

  private validateClaims(claims: JwtClaims, expectedType: TokenType): void {
    if (!claims || typeof claims !== 'object') {
      throw new AuthError('INVALID_CLAIMS', 'claims must be an object')
    }
    if (claims.iss !== this.config.issuer) {
      throw new AuthError('INVALID_CLAIMS', 'invalid issuer (iss)')
    }
    if (!claims.sub || typeof claims.sub !== 'string') {
      throw new AuthError('INVALID_CLAIMS', 'invalid subject (sub)')
    }
    if (!Number.isInteger(claims.exp)) {
      throw new AuthError('INVALID_CLAIMS', 'invalid expiry (exp)')
    }
    if (claims.type !== expectedType) {
      throw new AuthError('UNSUPPORTED_TOKEN', `expected ${expectedType} token`)
    }

    const now = nowInSeconds()
    if (claims.exp + this.clockToleranceSeconds < now) {
      throw new AuthError('TOKEN_EXPIRED', 'token has expired')
    }
  }

  private getSecretForType(type: TokenType): string {
    return type === ACCESS_TOKEN_TYPE
      ? this.config.accessTokenSecret
      : this.config.refreshTokenSecret
  }
}

/**
 * Returns AuthService config from environment variables.
 */
export function getAuthConfigFromEnv(): AuthConfig {
  return {
    issuer: process.env.JWT_ISSUER ?? 'credence-api',
    accessTokenSecret:
      process.env.JWT_ACCESS_TOKEN_SECRET ?? 'dev-access-secret-change-me',
    refreshTokenSecret:
      process.env.JWT_REFRESH_TOKEN_SECRET ?? 'dev-refresh-secret-change-me',
    accessTokenExpiry: process.env.JWT_ACCESS_TOKEN_EXPIRY ?? '15m',
    refreshTokenExpiry: process.env.JWT_REFRESH_TOKEN_EXPIRY ?? '7d',
    clockToleranceSeconds: parseOptionalInteger(process.env.JWT_CLOCK_TOLERANCE_SECONDS),
  }
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

function parseExpiryToSeconds(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new AuthError('INVALID_CLAIMS', 'expiry values must be positive numbers')
    }
    return Math.floor(value)
  }

  const match = /^(\d+)([smhd])$/i.exec(value.trim())
  if (!match) {
    throw new AuthError(
      'INVALID_CLAIMS',
      'expiry values must be number of seconds or string in s/m/h/d format'
    )
  }

  const amount = Number.parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 60 * 60 * 24,
  }
  return amount * multipliers[unit]
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

function decodeTokenPart<T>(value: string, partName: string): T {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    return JSON.parse(decoded) as T
  } catch {
    throw new AuthError('INVALID_TOKEN', `invalid ${partName}`)
  }
}

function safeCompare(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')

  if (actualBuffer.length !== expectedBuffer.length) {
    return false
  }

  return timingSafeEqual(actualBuffer, expectedBuffer)
}
