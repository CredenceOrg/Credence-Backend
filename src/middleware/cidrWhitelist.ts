import type { Request, Response, NextFunction } from 'express'
import { isIPv4 } from 'net'

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
}

function parseCidr(cidr: string): { network: number; mask: number } | null {
  const parts = cidr.trim().split('/')
  if (parts.length !== 2) return null
  const [addr, prefixStr] = parts
  if (!isIPv4(addr)) return null
  const prefix = parseInt(prefixStr, 10)
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return null
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return { network: ipToInt(addr) & mask, mask }
}

export function ipMatchesAnyCidr(ip: string, cidrs: string[]): boolean {
  if (!isIPv4(ip)) return false
  const ipInt = ipToInt(ip)
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr)
    if (parsed && (ipInt & parsed.mask) === parsed.network) return true
  }
  return false
}

export function createCidrWhitelistMiddleware(allowedCidrs: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? ''
    if (ipMatchesAnyCidr(ip, allowedCidrs)) {
      next()
      return
    }
    res.status(403).json({ error: 'Metrics endpoint not accessible from this network' })
  }
}
