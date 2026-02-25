import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { AuthError, AuthService } from './auth.js'

describe('AuthService', () => {
  let authService: AuthService

  beforeEach(() => {
    authService = new AuthService({
      issuer: 'credence-test',
      accessTokenSecret: 'access-secret',
      refreshTokenSecret: 'refresh-secret',
      accessTokenExpiry: '1h',
      refreshTokenExpiry: '7d',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('issues access and refresh tokens with configured expiries', () => {
    const tokenPair = authService.issueTokenPair('user-1')

    expect(tokenPair.accessToken).toEqual(expect.any(String))
    expect(tokenPair.refreshToken).toEqual(expect.any(String))
    expect(tokenPair.accessTokenExpiresInSeconds).toBe(3600)
    expect(tokenPair.refreshTokenExpiresInSeconds).toBe(604800)
  })

  it('validates access token signature and required claims', () => {
    const tokenPair = authService.issueTokenPair('user-1')
    const claims = authService.verifyAccessToken(tokenPair.accessToken)

    expect(claims.iss).toBe('credence-test')
    expect(claims.sub).toBe('user-1')
    expect(claims.exp).toEqual(expect.any(Number))
    expect(claims.type).toBe('access')
  })

  it('rejects tampered tokens', () => {
    const tokenPair = authService.issueTokenPair('user-1')
    const tamperedToken = `${tokenPair.accessToken}tampered`

    expect(() => authService.verifyAccessToken(tamperedToken)).toThrow(AuthError)
    expect(() => authService.verifyAccessToken(tamperedToken)).toThrow(
      'invalid token signature'
    )
  })

  it('rejects tokens with wrong signature secret', () => {
    const tokenPair = authService.issueTokenPair('user-1')
    const otherService = new AuthService({
      issuer: 'credence-test',
      accessTokenSecret: 'different-secret',
      refreshTokenSecret: 'refresh-secret',
      accessTokenExpiry: '1h',
      refreshTokenExpiry: '7d',
    })

    expect(() => otherService.verifyAccessToken(tokenPair.accessToken)).toThrow(AuthError)
    expect(() => otherService.verifyAccessToken(tokenPair.accessToken)).toThrow(
      'invalid token signature'
    )
  })

  it('rejects expired access tokens', () => {
    const clock = new Date('2026-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(clock)

    const shortLivedAuth = new AuthService({
      issuer: 'credence-test',
      accessTokenSecret: 'access-secret',
      refreshTokenSecret: 'refresh-secret',
      accessTokenExpiry: '1s',
      refreshTokenExpiry: '7d',
    })

    const tokenPair = shortLivedAuth.issueTokenPair('user-1')
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))

    expect(() => shortLivedAuth.verifyAccessToken(tokenPair.accessToken)).toThrow(AuthError)
    expect(() => shortLivedAuth.verifyAccessToken(tokenPair.accessToken)).toThrow(
      'token has expired'
    )
  })

  it('rejects token when issuer claim is invalid', () => {
    const tokenPair = authService.issueTokenPair('user-1')
    const otherIssuerAuth = new AuthService({
      issuer: 'other-issuer',
      accessTokenSecret: 'access-secret',
      refreshTokenSecret: 'refresh-secret',
      accessTokenExpiry: '1h',
      refreshTokenExpiry: '7d',
    })

    expect(() => otherIssuerAuth.verifyAccessToken(tokenPair.accessToken)).toThrow(AuthError)
    expect(() => otherIssuerAuth.verifyAccessToken(tokenPair.accessToken)).toThrow(
      'invalid issuer (iss)'
    )
  })

  it('rejects token when subject claim is missing', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = signJwt(
      {
        alg: 'HS256',
        typ: 'JWT',
      },
      {
        iss: 'credence-test',
        sub: '',
        iat: now,
        exp: now + 3600,
        type: 'access',
      },
      'access-secret'
    )

    expect(() => authService.verifyAccessToken(token)).toThrow(AuthError)
    expect(() => authService.verifyAccessToken(token)).toThrow('invalid subject (sub)')
  })

  it('rejects using refresh token as access token', () => {
    const tokenPair = authService.issueTokenPair('user-1')

    expect(() => authService.verifyAccessToken(tokenPair.refreshToken)).toThrow(AuthError)
    expect(() => authService.verifyAccessToken(tokenPair.refreshToken)).toThrow(
      'invalid token signature'
    )
  })

  it('supports refresh token flow by issuing a new token pair', () => {
    const tokenPair = authService.issueTokenPair('user-1')
    const rotatedPair = authService.refreshToken(tokenPair.refreshToken)

    expect(rotatedPair.accessToken).not.toBe(tokenPair.accessToken)
    expect(rotatedPair.refreshToken).not.toBe(tokenPair.refreshToken)

    const claims = authService.verifyAccessToken(rotatedPair.accessToken)
    expect(claims.sub).toBe('user-1')
  })

  it('requires subject when issuing tokens', () => {
    expect(() => authService.issueTokenPair('')).toThrow(AuthError)
    expect(() => authService.issueTokenPair('')).toThrow('subject (sub) is required')
  })
})

function signJwt(header: object, payload: object, secret: string): string {
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url')
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}
