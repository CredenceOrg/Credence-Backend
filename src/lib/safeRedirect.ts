import { UnsafeRedirectError } from './errors.js'

/**
 * Control characters (C0 + DEL) that must never appear in a redirect target.
 * Attackers use these to smuggle scheme separators past naive string checks.
 */
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/

/**
 * A "safe" relative redirect target is a single-slash, same-origin path.
 * Browsers treat a leading `//` (protocol-relative) or a leading backslash
 * (`/\`, `\/`, `\\`) as an authority separator, so those must be rejected
 * even though they superficially "start with a slash".
 */
function isSafeRelativePath(target: string): boolean {
  if (!target.startsWith('/')) return false
  if (target.startsWith('//')) return false
  if (target.startsWith('/\\')) return false
  if (target.startsWith('\\')) return false

  let decoded: string
  try {
    decoded = decodeURIComponent(target)
  } catch {
    return false
  }

  if (decoded.startsWith('//') || decoded.startsWith('/\\') || decoded.startsWith('\\')) {
    return false
  }
  if (CONTROL_CHAR_PATTERN.test(decoded)) return false

  return true
}

/**
 * An absolute URL is only safe when its scheme is http(s) and its host
 * (hostname + port) is on the caller-supplied allowlist. Parsing with the
 * WHATWG URL class (rather than substring matching) is what makes userinfo
 * tricks like `https://trusted.example@evil.com/` resolve to the real host.
 */
function isAllowedAbsoluteUrl(target: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return false

  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const host = parsed.host.toLowerCase()
  return allowedHosts.some((allowed) => allowed.toLowerCase() === host)
}

/**
 * Returns true when `target` is safe to pass to `res.redirect()`: either a
 * same-origin relative path, or an absolute http(s) URL whose host is on the
 * allowlist. Anything else (protocol-relative URLs, `javascript:`/`data:`
 * schemes, backslash tricks, unlisted external hosts) is rejected.
 */
export function isSafeRedirectTarget(
  target: unknown,
  allowedHosts: readonly string[] = []
): target is string {
  if (typeof target !== 'string' || target.length === 0) return false
  if (CONTROL_CHAR_PATTERN.test(target)) return false

  return isSafeRelativePath(target) || isAllowedAbsoluteUrl(target, allowedHosts)
}

/**
 * Validates `target` and returns it unchanged if safe. Throws
 * `UnsafeRedirectError` (a typed, catalog-backed `AppError`) otherwise, so
 * callers can surface a `400` via the standard error-handling pipeline
 * instead of following an attacker-controlled Location header.
 */
export function resolveSafeRedirectTarget(
  target: unknown,
  allowedHosts: readonly string[] = []
): string {
  if (!isSafeRedirectTarget(target, allowedHosts)) {
    throw new UnsafeRedirectError('Redirect target is not an allowed relative path or allow-listed host', {
      target: typeof target === 'string' ? target : typeof target,
    })
  }
  return target
}
