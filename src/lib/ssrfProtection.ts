/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Defence-in-depth: validates that outbound URLs do not target private/internal
 * network ranges, localhost, or cloud metadata endpoints. Even if an attacker
 * gains the ability to configure outbound URLs (e.g. webhook targets), this
 * layer prevents them from pivoting into internal infrastructure.
 *
 * THREAT MODEL:
 * Without this check, an attacker who controls a webhook URL (or any
 * user-configurable outbound target) could:
 *   1. Point it at the AWS/GCP/Azure metadata endpoint (169.254.169.254) to
 *      exfiltrate IAM credentials, instance identity tokens, or service-account
 *      keys.
 *   2. Target internal services on the private network (10.x, 192.168.x, etc.)
 *      for lateral movement or data exfiltration.
 *   3. Probe localhost services that are not externally exposed (databases,
 *      caches, admin APIs).
 */

import { isIPv4, isIPv6 } from 'node:net'
import { logger } from '../utils/logger.js'

// ---------------------------------------------------------------------------
// Known metadata / internal hostnames (case-insensitive match)
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  // AWS EC2 instance metadata hostnames
  'instance-data',
  'instance-data.ec2.internal',
  'instance-data.eu-west-1.compute.internal',
  // GCP metadata hostnames
  'metadata.google.internal',
  'metadata',
])

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.local',
  '.internal',
  '.localhost',
  '.ec2.internal',
  '.compute.internal',
  '.compute.amazonaws.com',
]

// ---------------------------------------------------------------------------
// Private / reserved IPv4 range checks
// ---------------------------------------------------------------------------

/**
 * Private IPv4 address ranges per RFC 1918, RFC 6598, RFC 5735, RFC 3927.
 */
const PRIVATE_IPV4_RANGES: readonly [number, number][] = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8       "This host on this network"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8      Private-use
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8     Loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16  Link-local (includes metadata)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12   Private-use
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16  Private-use
  [0xe0000000, 0xefffffff], // 224.0.0.0/4     Multicast
  [0xf0000000, 0xffffffff], // 240.0.0.0/4     Reserved (includes broadcast 255.255.255.255)
]

/**
 * Private IPv6 address ranges.
 * Values are compared as 128-bit numbers using BigInt.
 */
const PRIVATE_IPV6_RANGES: readonly [bigint, bigint][] = [
  [BigInt('0x00000000000000000000000000000000'), BigInt('0x00000000000000000000000000000001')], // ::/127           Unspecified & loopback
  [BigInt('0x00000000000000000000000000000001'), BigInt('0x00000000000000000000000000000001')], // ::1              Loopback
  [BigInt('0xfe800000000000000000000000000000'), BigInt('0xfebfffffffffffffffffffffffffffff')], // fe80::/10        Link-local
  [BigInt('0xfc000000000000000000000000000000'), BigInt('0xfdffffffffffffffffffffffffffffff')], // fc00::/7         Unique local
]

// IPv4-mapped IPv6 prefix ::ffff:0:0/96
const IPV4_MAPPED_PREFIX = BigInt('0x00000000000000000000ffff00000000')
const IPV4_MAPPED_MASK = BigInt('0x00000000000000000000ffffffffffff')

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Convert an IPv4 address string to a 32-bit unsigned integer.
 * Assumes the input has already been validated as a dotted-decimal IPv4.
 */
function ipv4ToNumber(addr: string): number {
  const octets = addr.split('.')
  return (
    ((parseInt(octets[0]!, 10) & 0xff) << 24) |
    ((parseInt(octets[1]!, 10) & 0xff) << 16) |
    ((parseInt(octets[2]!, 10) & 0xff) << 8) |
    (parseInt(octets[3]!, 10) & 0xff)
  ) >>> 0 // coerce to unsigned 32-bit
}

/**
 * Expand a potentially compressed IPv6 address to its full 8-hextet form
 * so it can be reliably parsed into a 128-bit BigInt.
 *
 * Example: "::1" → "0:0:0:0:0:0:0:1"
 * Example: "fe80::1" → "fe80:0:0:0:0:0:0:1"
 * Example: "::ffff:10.0.0.1" → "0:0:0:0:0:ffff:10.0.0.1"
 *
 * Handles the IPv4-mapped notation where the last "hextet" group contains
 * a dotted IPv4 address (::ffff:x.x.x.x).
 */
function expandIPv6(addr: string): string {
  // If the address contains an IPv4-mapped suffix, handle it specially.
  // The URL parser gives us hostnames like "::ffff:10.0.0.1" where the last
  // component after the final colon is a dotted IPv4 address.
  const ipv4SuffixMatch = addr.match(/:(\d+\.\d+\.\d+\.\d+)$/)
  const ipv4Suffix = ipv4SuffixMatch ? ipv4SuffixMatch[1] : null
  const addrWithoutIpv4 = ipv4Suffix ? addr.slice(0, -(ipv4Suffix!.length + 1)) : addr

  if (addrWithoutIpv4.includes('::')) {
    const parts = addrWithoutIpv4.split('::')
    const left = parts[0] ? parts[0].split(':').filter(Boolean) : []
    const right = parts[1] ? parts[1].split(':').filter(Boolean) : []
    const totalGroups = left.length + right.length + (ipv4Suffix ? 1 : 0)
    const missing = 8 - totalGroups
    const zeros = Array(missing).fill('0')
    const expanded = [...left, ...zeros, ...right]
    if (ipv4Suffix) {
      expanded.push(ipv4Suffix)
    }
    addr = expanded.join(':')
  }

  return addr
}

/**
 * Convert an IPv6 address string to a 128-bit BigInt.
 * Handles both expanded and compressed (::) forms via expandIPv6().
 */
function ipv6ToBigInt(addr: string): bigint {
  const expanded = expandIPv6(addr)
  const parts = expanded.split(':')
  let result = BigInt(0)
  for (const part of parts) {
    result = (result << BigInt(16)) | BigInt(parseInt(part || '0', 16))
  }
  return result
}

/**
 * Check if a raw IPv4 literal falls within any private/reserved range.
 */
function isPrivateIPv4(addr: string): boolean {
  const num = ipv4ToNumber(addr)
  for (const [start, end] of PRIVATE_IPV4_RANGES) {
    if (num >= start && num <= end) return true
  }
  return false
}

/**
 * Check if a raw IPv6 literal falls within any private/reserved range.
 */
function isPrivateIPv6(addr: string): boolean {
  const big = ipv6ToBigInt(addr)

  for (const [start, end] of PRIVATE_IPV6_RANGES) {
    if (big >= start && big <= end) return true
  }

  // Check for IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
  if ((big & IPV4_MAPPED_MASK) === IPV4_MAPPED_PREFIX) {
    const ipv4Num = Number(big & BigInt(0xffffffff))
    for (const [start, end] of PRIVATE_IPV4_RANGES) {
      if (ipv4Num >= start && ipv4Num <= end) return true
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result for a blocked host check. Discriminated union so callers can
 * branch on the specific rejection reason without string matching.
 */
export type BlockedHostResult =
  | { blocked: false }
  | { blocked: true; reason: 'private_ipv4'; host: string }
  | { blocked: true; reason: 'private_ipv6'; host: string }
  | { blocked: true; reason: 'blocked_hostname'; host: string }
  | { blocked: true; reason: 'blocked_suffix'; host: string }

/**
 * Check whether a URL's hostname targets a restricted / internal address.
 *
 * The check is performed on the **hostname** extracted from the URL. It covers:
 * - Raw IPv4 literals in private/reserved ranges
 * - Raw IPv6 literals in private/reserved ranges (including IPv4-mapped)
 * - Known blocked hostnames (localhost, metadata endpoints, etc.)
 * - Hostnames ending with blocked suffixes (.local, .internal, etc.)
 *
 * @param url - The full URL string to validate (e.g. "http://10.0.0.1/admin").
 * @returns A discriminated union – check `blocked` to know if it's safe.
 */
export function checkHostBlocked(url: string): BlockedHostResult {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // If the URL is unparseable, let the caller / fetch handle it.
    // We don't block here – we only block on hostname patterns.
    return { blocked: false }
  }

  const hostname = parsed.hostname.toLowerCase()

  // 1. Check against exact-match blocked hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    logger.warn({ message: 'SSRF blocked hostname', url: redactUrl(url), host: hostname })
    return { blocked: true, reason: 'blocked_hostname', host: hostname }
  }

  // 2. Check against blocked hostname suffixes
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      logger.warn({ message: 'SSRF blocked suffix', url: redactUrl(url), host: hostname, suffix })
      return { blocked: true, reason: 'blocked_suffix', host: hostname }
    }
  }

  // 3. Check raw IPv4 literals
  if (isIPv4(hostname)) {
    if (isPrivateIPv4(hostname)) {
      logger.warn({ message: 'SSRF blocked private IPv4', url: redactUrl(url), host: hostname })
      return { blocked: true, reason: 'private_ipv4', host: hostname }
    }
    // Public IPv4 – allowed
    return { blocked: false }
  }

  // 4. Check raw IPv6 literals
  if (isIPv6(hostname)) {
    if (isPrivateIPv6(hostname)) {
      logger.warn({ message: 'SSRF blocked private IPv6', url: redactUrl(url), host: hostname })
      return { blocked: true, reason: 'private_ipv6', host: hostname }
    }
    return { blocked: false }
  }

  // 5. Hostname-based check (not a raw IP) – allowed (DNS resolution will
  //    happen at the network layer; we trust system DNS here for defence-in-depth)
  return { blocked: false }
}

/**
 * Redact the URL for safe logging (strip query strings and fragments that
 * may contain secrets).
 */
function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}

/**
 * Synchronous version – checks only the hostname pattern without DNS resolution.
 * Suitable for request validation pipelines where we want fast blocking.
 *
 * @param hostname - The hostname extracted from a URL (e.g. "10.0.0.1").
 * @returns A discriminated union.
 */
export function checkHostnameBlocked(hostname: string): BlockedHostResult {
  const lower = hostname.toLowerCase()

  if (BLOCKED_HOSTNAMES.has(lower)) {
    return { blocked: true, reason: 'blocked_hostname', host: lower }
  }

  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return { blocked: true, reason: 'blocked_suffix', host: lower }
    }
  }

  if (isIPv4(lower)) {
    if (isPrivateIPv4(lower)) {
      return { blocked: true, reason: 'private_ipv4', host: lower }
    }
    return { blocked: false }
  }

  const lowerForIPv6 = lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower
  if (isIPv6(lowerForIPv6)) {
    if (isPrivateIPv6(lowerForIPv6)) {
      return { blocked: true, reason: 'private_ipv6', host: lower }
    }
    return { blocked: false }
  }

  return { blocked: false }
}
