# Incoming Webhook Security & Posture Guide

This document describes the security posture, verification mechanisms, replay protection, and network access controls for incoming webhooks within the **Credence Protocol** platform.

---

## Audience

This document is written for **downstream integrators and contributors** receiving event notifications from Credence or building services that ingest incoming webhooks.

---

## Security Posture Overview

Credence enforces a defense-in-depth posture for incoming webhooks based on three core security pillars:

1. **HMAC-SHA256 Signature Verification:** Ensures payload authenticity and message integrity.
2. **Replay Window Tolerance:** Rejects stale or replayed webhooks using timestamp validation.
3. **Allowed Origins & CIDR Whitelisting:** Restricts ingress traffic to authorized IP subnets and origins.

```
Incoming Webhook Request
         │
         ▼
┌────────────────────────────────┐
│  CIDR / Origin Whitelist       │ ──► Rejected (403 Forbidden)
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│  Replay Window Tolerance       │ ──► Expired / Replayed (401 Unauthorized)
│  (Default: 5 minutes / 300s)   │
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│  HMAC-SHA256 Signature Check   │ ──► Invalid Signature (401 Unauthorized)
│  (Constant-time comparison)    │
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│  Process Webhook Payload       │ ──► 200 OK
└────────────────────────────────┘
```

---

## 1. Signature Verification (HMAC-SHA256)

### Header Format

All incoming webhook HTTP requests convey an HMAC signature in the header:

```http
X-Webhook-Signature: sha256=a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0
```

- **Header Name:** `X-Webhook-Signature` (case-insensitive in HTTP/1.1 and HTTP/2).
- **Prefix:** `sha256=` followed by a 64-character hexadecimal digest (raw 64-char hex strings are also supported).

### Verification Algorithm

The signature is computed over the **unmodified, raw HTTP request body string** using the shared signing secret:

$$\text{Signature} = \text{HMAC-SHA256}(\text{rawBody}, \text{secret})$$

### Constant-Time Comparison

To prevent timing side-channel attacks, signatures must be compared using constant-time equality checks (`crypto.timingSafeEqual` in Node.js):

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyHmacSignature(rawBody: string, receivedHex: string, secret: string): boolean {
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expectedHex.length !== receivedHex.length) return false;
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(receivedHex, 'hex'));
}
```

### Dual-Secret Support During Rotation

When rotating a webhook secret, the system maintains a 24-hour safe rollout window:
- Both `currentSecret` and `previousSecret` are evaluated.
- If the signature matches either secret, the request is accepted.

---

## 2. Replay Protection & Timestamp Tolerance

### Timestamp Payload Field

Every webhook body contains an ISO-8601 UTC timestamp:

```json
{
  "event": "bond.created",
  "timestamp": "2026-07-25T06:24:00.000Z",
  "data": {
    "address": "0x123...",
    "bondedAmount": "5000"
  }
}
```

### Tolerance Window

- **Default Tolerance:** **5 minutes (300,000 milliseconds)**.
- **Rule:** The absolute difference between current server time `Date.now()` and the payload `timestamp` must not exceed the tolerance:

$$| \text{Date.now()} - \text{timestampMs} | \le 300,000\text{ ms}$$

- If the timestamp is missing, malformed, or exceeds tolerance, the request is rejected with `401 Unauthorized` (`expired` or `missing_timestamp` error reason).

---

## 3. Allowed Origins & CIDR Subnet Whitelisting

### CIDR IP Filtering

For high-security deployments, webhook endpoints can be protected by CIDR IP subnet filtering:

- **Middleware:** `createCidrWhitelistMiddleware(allowedCidrs)`
- **Mechanism:** Parses IPv4 addresses and checks subnet masks (`ipMatchesAnyCidr`).
- **Rejection Response:** `403 Forbidden` with body `{ "error": "Access denied from this network" }`.

### CORS & Origin Control

- Allowed origin headers (`Origin`, `Access-Control-Allow-Origin`) are validated on incoming HTTP webhooks.
- Reverse proxies and ingress controllers pass client IPs via standard `X-Forwarded-For` headers.

---

## Concrete Express Implementation Example

### Complete Middleware Usage

```typescript
import express, { Request, Response } from 'express';
import { verifyWebhookSignature } from '../middleware/webhookSignature.js';
import { createCidrWhitelistMiddleware } from '../middleware/cidrWhitelist.js';

const app = express();

// 1. Capture raw string body for accurate HMAC signature verification
app.use(express.text({ type: 'application/json' }));

// 2. Configure CIDR IP Whitelist (Optional)
const allowedCidrs = ['192.168.1.0/24', '10.0.0.0/16'];
app.use('/api/v1/webhooks/incoming', createCidrWhitelistMiddleware(allowedCidrs));

// 3. Configure Webhook Signature & Replay Verification
app.use(
  '/api/v1/webhooks/incoming',
  verifyWebhookSignature({
    secret: process.env.WEBHOOK_SIGNING_SECRET!,
    signatureHeader: 'x-webhook-signature',
    tolerance: 300000, // 5 minutes
  })
);

// 4. Ingress Endpoint Handler
app.post('/api/v1/webhooks/incoming', (req: Request, res: Response) => {
  const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  console.log(`Received verified event: ${payload.event}`);
  res.status(200).json({ success: true, receivedAt: new Date().toISOString() });
});
```

---

## Verification Error Codes Reference

| Error Code | HTTP Status | Description | Remediation |
|---|---|---|---|
| `missing_signature` | `401` | `X-Webhook-Signature` header is missing. | Ensure sender attaches `X-Webhook-Signature`. |
| `malformed_signature` | `401` | Signature format is invalid (not 64-char hex). | Verify signature encoding is hex. |
| `invalid_signature` | `401` | HMAC digest does not match secret. | Check secret key alignment / rotation status. |
| `missing_timestamp` | `401` | Payload `timestamp` field is missing or invalid. | Include ISO-8601 `timestamp` in body. |
| `expired` | `401` | Request timestamp is outside 5-minute window. | Sync clock via NTP or resend fresh event. |
| `Forbidden` | `403` | Origin IP is not in allowed CIDR range. | Update CIDR whitelist in configuration. |

---

## Related Documentation

- [Webhooks Overview](webhooks.md)
- [Replay Safe Handlers & Side Effects](REPLAY_SAFE_HANDLERS.md)
- [Idempotency Guard](IDEMPOTENCY_GUARD.md)
- [Security Guide](SECURITY.md)
