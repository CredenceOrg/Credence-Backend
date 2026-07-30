/**
 * Tests for SSRF protection utilities.
 *
 * Covers:
 * - Private IPv4 ranges blocked (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x)
 * - Private IPv6 ranges blocked (::1, fe80::, fc00::)
 * - IPv4-mapped IPv6 private addresses blocked
 * - Known blocked hostnames (localhost, metadata endpoints)
 * - Blocked hostname suffixes (.local, .internal)
 * - Public IPs allowed
 * - Public hostnames allowed
 */
import { describe, it, expect } from 'vitest'
import { checkHostBlocked, checkHostnameBlocked } from '../lib/ssrfProtection.js'

// ---------------------------------------------------------------------------
// URL-level checks
// ---------------------------------------------------------------------------

describe('checkHostBlocked', () => {
  // --- Private IPv4 ---
  describe('private IPv4 literals', () => {
    it('blocks 10.0.0.1', () => {
      expect(checkHostBlocked('http://10.0.0.1/admin')).toEqual({
        blocked: true,
        reason: 'private_ipv4',
        host: '10.0.0.1',
      })
    })

    it('blocks 10.255.255.255', () => {
      expect(checkHostBlocked('http://10.255.255.255/')).toEqual({
        blocked: true,
        reason: 'private_ipv4',
        host: '10.255.255.255',
      })
    })

    it('blocks 172.16.0.1', () => {
      expect(checkHostBlocked('http://172.16.0.1/')).toEqual({
        blocked: true,
        reason: 'private_ipv4',
        host: '172.16.0.1',
      })
    })

    it('blocks 172.31.255.255', () => {
      expect(checkHostBlocked('http://172.31.255.255/')).toEqual({
        blocked: true,
        reason: 'private_ipv4',
        host: '172.31.255.255',
      })
    })

    it('blocks 192.168.0.0', () => {
      expect(checkHostBlocked('http://192.168.0.0/')).toEqual({
        blocked: true,
        reason: 'private_ipv4',
        host: '192.168.0.0',
      })
    })

    it('blocks 192.168.255.255', () => {
      expect(checkHostBlocked('http://192.168.255.255/')).toEqual({
        blocked: true,
        reason: 'private_ipv4',
        host: '192.168.255.255',
      })
    })
  })

  // --- Loopback ---
  describe('loopback addresses', () => {
    it('blocks 127.0.0.1', () => {
      expect(checkHostBlocked('http://127.0.0.1:3000/api')).toEqual({
        blocked: true,
        reason: 'private_ipv4',
        host: '127.0.0.1',
      })
    })

    it('blocks 127.255.255.255', () => {
      expect(checkHostBlocked('http://127.255.255.255/')).toEqual({
        blocked: true,
        reason: 'private_ipv4',
        host: '127.255.255.255',
      })
    })
  })

  // --- Metadata endpoint ---
  describe('metadata endpoint (169.254.169.254)', () => {
    it('blocks 169.254.169.254 (link-local range, private IPv4)', () => {
      expect(checkHostBlocked('http://169.254.169.254/latest/meta-data/')).toEqual({
        blocked: true,
        reason: 'private_ipv4',
        host: '169.254.169.254',
      })
    })

    it('blocks instance-data hostname', () => {
      expect(checkHostBlocked('http://instance-data/metadata')).toEqual({
        blocked: true,
        reason: 'blocked_hostname',
        host: 'instance-data',
      })
    })

    it('blocks metadata.google.internal', () => {
      expect(checkHostBlocked('http://metadata.google.internal/')).toEqual({
        blocked: true,
        reason: 'blocked_hostname',
        host: 'metadata.google.internal',
      })
    })

    it('blocks metadata hostname', () => {
      expect(checkHostBlocked('http://metadata/')).toEqual({
        blocked: true,
        reason: 'blocked_hostname',
        host: 'metadata',
      })
    })
  })

  // --- Localhost hostname ---
  describe('localhost hostname', () => {
    it('blocks localhost', () => {
      expect(checkHostBlocked('http://localhost:8080/')).toEqual({
        blocked: true,
        reason: 'blocked_hostname',
        host: 'localhost',
      })
    })

    it('blocks localhost.localdomain', () => {
      expect(checkHostBlocked('http://localhost.localdomain/')).toEqual({
        blocked: true,
        reason: 'blocked_hostname',
        host: 'localhost.localdomain',
      })
    })
  })

  // --- Private IPv6 ---
  describe('private IPv6 literals', () => {
    it('blocks ::1 (loopback)', () => {
      expect(checkHostBlocked('http://[::1]:3000/api')).toEqual({
        blocked: true,
        reason: 'private_ipv6',
        host: '::1',
      })
    })

    it('blocks fe80::1 (link-local)', () => {
      expect(checkHostBlocked('http://[fe80::1]/')).toEqual({
        blocked: true,
        reason: 'private_ipv6',
        host: 'fe80::1',
      })
    })

    it('blocks fc00::1 (unique local)', () => {
      expect(checkHostBlocked('http://[fc00::1]/')).toEqual({
        blocked: true,
        reason: 'private_ipv6',
        host: 'fc00::1',
      })
    })
  })

  // --- IPv4-mapped IPv6 ---
  describe('IPv4-mapped IPv6', () => {
    it('blocks ::ffff:127.0.0.1', () => {
      expect(checkHostBlocked('http://[::ffff:127.0.0.1]/')).toEqual({
        blocked: true,
        reason: 'private_ipv6',
        host: '::ffff:127.0.0.1',
      })
    })

    it('blocks ::ffff:10.0.0.1', () => {
      expect(checkHostBlocked('http://[::ffff:10.0.0.1]/')).toEqual({
        blocked: true,
        reason: 'private_ipv6',
        host: '::ffff:10.0.0.1',
      })
    })
  })

  // --- Blocked suffixes ---
  describe('blocked hostname suffixes', () => {
    it('blocks *.local', () => {
      expect(checkHostBlocked('http://internal-api.local/')).toEqual({
        blocked: true,
        reason: 'blocked_suffix',
        host: 'internal-api.local',
      })
    })

    it('blocks *.internal', () => {
      expect(checkHostBlocked('http://db.internal/')).toEqual({
        blocked: true,
        reason: 'blocked_suffix',
        host: 'db.internal',
      })
    })

    it('blocks *.ec2.internal', () => {
      expect(checkHostBlocked('http://i-12345.ec2.internal/')).toEqual({
        blocked: true,
        reason: 'blocked_suffix',
        host: 'i-12345.ec2.internal',
      })
    })
  })

  // --- Allowed (public) ---
  describe('public / allowed targets', () => {
    it('allows public IPv4 (8.8.8.8)', () => {
      expect(checkHostBlocked('http://8.8.8.8/')).toEqual({ blocked: false })
    })

    it('allows public IPv4 (1.1.1.1)', () => {
      expect(checkHostBlocked('https://1.1.1.1/')).toEqual({ blocked: false })
    })

    it('allows public IPv6 (2001:4860:4860::8888)', () => {
      expect(checkHostBlocked('http://[2001:4860:4860::8888]/')).toEqual({ blocked: false })
    })

    it('allows public hostname', () => {
      expect(checkHostBlocked('https://api.example.com/webhook')).toEqual({ blocked: false })
    })

    it('allows sendgrid API', () => {
      expect(checkHostBlocked('https://api.sendgrid.com/v3/mail/send')).toEqual({ blocked: false })
    })

    it('allows 172.15.0.1 (outside 172.16/12 range)', () => {
      expect(checkHostBlocked('http://172.15.0.1/')).toEqual({ blocked: false })
    })

    it('allows 172.32.0.1 (outside 172.16/12 range)', () => {
      expect(checkHostBlocked('http://172.32.0.1/')).toEqual({ blocked: false })
    })

    it('blocks 0.0.0.0 (reserved range)', () => {
      expect(checkHostBlocked('http://0.0.0.0/')).toEqual({
        blocked: true,
        reason: 'private_ipv4',
        host: '0.0.0.0',
      })
    })

    it('allows invalid URL gracefully (does not block)', () => {
      expect(checkHostBlocked('not-a-url')).toEqual({ blocked: false })
    })

    it('allows 9.9.9.9', () => {
      expect(checkHostBlocked('https://9.9.9.9/')).toEqual({ blocked: false })
    })
  })
})

// ---------------------------------------------------------------------------
// Hostname-level checks
// ---------------------------------------------------------------------------

describe('checkHostnameBlocked', () => {
  it('blocks 10.0.0.1 as IP literal', () => {
    expect(checkHostnameBlocked('10.0.0.1')).toEqual({
      blocked: true,
      reason: 'private_ipv4',
      host: '10.0.0.1',
    })
  })

  it('allows public IPv4 8.8.8.8', () => {
    expect(checkHostnameBlocked('8.8.8.8')).toEqual({ blocked: false })
  })

  it('blocks localhost', () => {
    expect(checkHostnameBlocked('localhost')).toEqual({
      blocked: true,
      reason: 'blocked_hostname',
      host: 'localhost',
    })
  })

  it('blocks ::1', () => {
    expect(checkHostnameBlocked('::1')).toEqual({
      blocked: true,
      reason: 'private_ipv6',
      host: '::1',
    })
  })

  it('allows example.com', () => {
    expect(checkHostnameBlocked('example.com')).toEqual({ blocked: false })
  })
})
