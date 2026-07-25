# Rate Limiting Design

## Overview

Credence Backend enforces per-tier rate limits using a token-bucket
algorithm. Each API key is assigned a tier, and each tier has its own
bucket size, refill rate, and burst allowance.

## Tier model

| Tier | Bucket size | Refill rate | Burst allowance | Reset window |
|------|-------------|-------------|------------------|---------------|
| <<<TIER_1>>> | <<<SIZE>>> | <<<RATE>>> | <<<BURST>>> | <<<WINDOW>>> |
| <<<TIER_2>>> | <<<SIZE>>> | <<<RATE>>> | <<<BURST>>> | <<<WINDOW>>> |
| <<<TIER_3>>> | <<<SIZE>>> | <<<RATE>>> | <<<BURST>>> | <<<WINDOW>>> |

## Example

```bash
curl -i http://localhost:3000/api/<<<REAL_ENDPOINT>>> \
  -H "Authorization: Bearer <<<TOKEN>>>"
```

Response headers on a request under the limit:
Response when the bucket is exhausted (HTTP 429):

```json
{
  "error": "<<<REAL_ERROR_MESSAGE_FROM_MIDDLEWARE>>>"
}
```

## Configuration

Rate limiting is controlled by the following environment variables
(see `.env.example`):

| Variable | Default | Description |
|----------|---------|--------------|
| <<<VAR_NAME>>> | <<<DEFAULT>>> | <<<DESCRIPTION>>> |

## Related docs

- [API documentation](./api.md)
- [Monitoring](./monitoring.md)

## Rate Limiting

[#rate-limiting](#rate-limiting)

API requests are limited per-tier using a token-bucket algorithm. See
**[docs/RATE_LIMITING_DESIGN.md](./docs/RATE_LIMITING_DESIGN.md)** for
tier sizes, burst allowance, and reset windows.