# Webhook Signature Generation & Verification — Operator Guide

This guide describes how webhook signatures are generated, transmitted, verified, and rotated within the Credence platform. It is written for **system operators, DevOps engineers, and support engineers** maintaining webhook delivery infrastructure, configuring verification gateways, and troubleshooting integration failures.

---

## Overview

Credence uses HMAC-SHA256 signatures to ensure the authenticity and integrity of outgoing webhook notifications. Webhook payloads are signed with a shared secret assigned to each webhook endpoint subscriber.

When receiving a webhook delivery, operators and consumer applications must verify the signature header before processing the event body to prevent unauthorized injection, tampering, or replay attacks.

---

## 1. Webhook Signature Specification

### 1.1 Signature Algorithm & Format
- **Algorithm**: HMAC-SHA256 (`crypto.createHmac('sha256', secret)`)
- **Digest Output**: 64-character hexadecimal string (`digest('hex')`)
- **Header Name**: `x-webhook-signature` (case-insensitive)
- **Header Formats Supported**:
  - `sha256=<hex_digest>` (e.g. `sha256=a1b2c3d4e5f6...`)
  - `<hex_digest>` (e.g. `a1b2c3d4e5f6...`)

### 1.2 Payload Signing Mechanism
The signature is generated over the exact UTF-8 encoded JSON string body sent in the HTTP POST request.

**Server Signing Logic ([`src/services/webhooks/delivery.ts`](../src/services/webhooks/delivery.ts)):**
```typescript
import { createHmac } from 'node:crypto';

export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}
```

---

## 2. Replay Protection & Timestamp Verification

To defend against replay attacks where an attacker re-sends a captured valid webhook request, Credence embeds an ISO-8601 UTC timestamp inside every webhook payload body:

```json
{
  "id": "evt_123456789",
  "event": "bond.status.updated",
  "timestamp": "2026-07-25T06:30:00.000Z",
  "data": {
    "identityId": "id_987654321",
    "status": "active"
  }
}
```

### Replay Window Tolerance
- **Default Tolerance**: 5 minutes (`300,000 ms`).
- **Verification Rule**: The receiver must evaluate `Math.abs(Date.now() - timestamp) <= tolerance`.
- Requests with missing timestamps, invalid date formats, or timestamps skewed outside the 5-minute tolerance window are rejected immediately.

---

## 3. Timing-Safe Signature Verification

Signature verification must perform fixed-time byte comparisons to prevent side-channel timing attacks that leak signature characters.

**Verification Logic ([`src/lib/webhookVerifier.ts`](../src/lib/webhookVerifier.ts)):**
```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

export function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
```

---

## 4. Secret Rotation & Dual-Key Grace Period

Operators can rotate a webhook's shared secret without incurring downtime or dropping events during client migration.

**Rotation Semantics ([`src/services/webhooks/rotationService.ts`](../src/services/webhooks/rotationService.ts)):**
1. **New Secret Generation**: A new 32-byte cryptographically random hex secret is generated (`randomBytes(32).toString('hex')`).
2. **24-Hour Grace Period**: The old secret is preserved in the database as `previousSecret` with an expiration timestamp (`previousSecretExpiresAt = now + 24 hours`).
3. **Dual-Key Verification**: During the 24-hour window, verification attempts check `currentSecret` first, falling back to `previousSecret` if `currentSecret` fails.
4. **Audit Logging**: Every secret rotation triggers an immutable audit log entry (`ROTATE_WEBHOOK_SECRET`).

---

## 5. Express Middleware Integration

Credence provides an Express middleware [`verifyWebhookSignature`](../src/middleware/webhookSignature.ts) for receiver endpoints.

### Usage Example
```typescript
import express from 'express';
import { verifyWebhookSignature } from './src/middleware/webhookSignature.js';

const app = express();

// Configure raw or JSON body parsing
app.use(express.json());

// Protect inbound webhook receiver endpoint
app.post(
  '/webhooks/receiver',
  verifyWebhookSignature({
    secret: process.env.WEBHOOK_SHARED_SECRET!,
    signatureHeader: 'x-webhook-signature',
    tolerance: 300000, // 5 minutes tolerance
  }),
  (req, res) => {
    // Verified request handler
    res.status(200).json({ received: true });
  }
);
```

---

## 6. Operator Troubleshooting & Diagnostics Runbook

When an incoming webhook request fails verification, the middleware rejects it with HTTP `401 Unauthorized`. Use the table below to diagnose and resolve failure reasons returned by [`verifySignature`](../src/lib/webhookVerifier.ts):

| Failure Reason | Description | Root Cause | Operator Action |
| --- | --- | --- | --- |
| `missing_secret` | Secret undefined on server | No active or previous secret configured for endpoint | Check database configuration / subscriber secret mapping. |
| `missing_signature` | `x-webhook-signature` header absent | Request header stripped by reverse proxy or API gateway | Verify proxy header forwarding (`x-webhook-signature`). |
| `malformed_signature` | Signature format invalid | Header value is non-hex or not 64 hexadecimal characters | Inspect sender header formatting; ensure SHA-256 hex encoding. |
| `missing_timestamp` | Body missing `timestamp` field | Raw payload string altered before parsing or invalid JSON | Ensure raw body is preserved prior to JSON parsing middleware. |
| `invalid_timestamp` | Timestamp string invalid | `timestamp` field contains non-ISO-8601 string or non-numeric value | Inspect clock sync on originating event publisher. |
| `expired` | Timestamp skew exceeds tolerance | Clock drift between sender and receiver > 5 minutes (`300,000 ms`) | Check NTP sync on servers or increase `tolerance` option. |
| `invalid_signature` | HMAC mismatch | Payload modified in transit or incorrect shared secret used | Verify shared secret match or test against `previousSecret`. |

---

## Related Documentation
- [Webhooks Architecture Guide](webhooks.md) — Delivery pipeline, retries, and dead-letter queues.
- [Secrets Management Policy](SECRETS.md) — Secret lifecycle, KMS integration, and rotation schedules.
- [Security Architecture](SECURITY.md) — Security posture, API key scopes, and threat models.
- [Replay-Safe Handlers](REPLAY_SAFE_HANDLERS.md) — Preventing duplicate side-effects during retries.
