# Request Validation

Centralized, Zod-backed request validation for all Credence API routes.

## Overview

`src/middleware/validate.ts` exports a single `validate()` middleware factory that
validates **path parameters**, **query strings**, and **JSON bodies** against Zod
schemas before any handler logic runs.

When validation fails, a uniform `400 Bad Request` response is returned with a
stable `error_code` and field-level details — no handler code is executed.

```
POST /api/... → validate() → handler / service layer
                    │
                    └─ invalid? → ValidationError → errorHandler → 400 JSON
```

---

## Quick Start

```ts
import { validate } from '../middleware/validate.js'
import { z } from 'zod'

const myBodySchema = z.object({
  name:  z.string().min(1),
  score: z.number().int().min(0).max(100),
})

router.post(
  '/',
  validate({ body: myBodySchema }),
  (req, res) => {
    // req.validated.body is fully typed: { name: string; score: number }
    const { name, score } = req.validated!.body as z.infer<typeof myBodySchema>
    res.json({ name, score })
  },
)
```

For **no-any** downstream access, use the `ValidatedRequest` helper type:

```ts
import { validate, type ValidatedRequest } from '../middleware/validate.js'

type MyParams = { id: string }
type MyBody   = { name: string }

router.patch(
  '/:id',
  validate({ params: myParamsSchema, body: myBodySchema }),
  (req: ValidatedRequest<MyParams, any, MyBody>, res) => {
    const { id }   = req.validated.params   // string – no cast needed
    const { name } = req.validated.body     // string – no cast needed
    res.json({ id, name })
  },
)
```

---

## API

```ts
function validate(options: ValidateOptions): Express.RequestHandler
```

### `ValidateOptions`

| Key | Type | Description |
|-----|------|-------------|
| `params` | `ZodSchema \| undefined` | Schema for `req.params` (path parameters) |
| `query`  | `ZodSchema \| undefined` | Schema for `req.query` (query string) |
| `body`   | `ZodSchema \| undefined` | Schema for `req.body` (JSON body) |

Omitting a key skips validation for that source entirely.

### Behaviour

1. Each provided schema is applied via `schema.safeParse()`.
2. On success the **parsed, coerced, stripped** value is:
   - Written back onto `req.params` / `req.query` / `req.body`
   - Available on `req.validated.params` / `.query` / `.body`
3. On failure all field-level errors are **collected** across all sources, then
   `next(new ValidationError(...))` is called; the global `errorHandler` formats
   the response.

### Error behaviour: unknown fields

- **Default (strip)** – unrecognised keys are silently removed from the validated value.
- **Strict (`z.object({...}).strict()`)** – unrecognised keys produce an `unexpected_field` error.

---

## Error Envelope (400 response)

```json
{
  "error":      "Validation failed",
  "code":       "validation_failed",
  "error_code": "validation_failed",
  "details": [
    {
      "path":    "body.amount",
      "message": "Too small: expected number to be >=0",
      "code":    "value_too_small"
    },
    {
      "path":    "body.currency",
      "message": "Invalid option: expected one of \"USD\"|\"EUR\"",
      "code":    "invalid_type"
    }
  ]
}
```

### `error_code` values in `details[]`

| Zod issue | `code` |
|-----------|--------|
| `invalid_type` + received undefined | `field_required` |
| `invalid_type` (wrong type) | `invalid_type` |
| `invalid_format` (email, uuid…) | `invalid_format` |
| `invalid_format` where path contains "address" | `invalid_address` |
| `invalid_value` (enum mismatch) | `invalid_type` |
| `too_small` | `value_too_small` |
| `too_big` | `value_too_large` |
| `unrecognized_keys` | `unexpected_field` |
| `custom` + message `INVALID_STELLAR_ADDRESS` | `invalid_stellar_address` |
| `custom` + message contains "address" | `invalid_address` |
| anything else | `validation_failed` |

---

## Query String Coercion

HTTP query parameters arrive as strings. Use `z.coerce` to convert them:

```ts
const querySchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q:     z.string().optional(),
})
```

After validation, `req.validated.query.page` is a `number`, not a `string`.

---

## Migrated Routes

The following routes use `validate()`:

| Route | Source(s) validated |
|-------|---------------------|
| `GET /api/trust/:address` | `params` (`trustPathParamsSchema`) |
| `POST /api/reports` | `body` (`createReportBodySchema`) |
| `GET /api/transactions/history` | `query` (`transactionsHistoryQuerySchema`) |
| `POST /api/orgs/:orgId/policies` | `params` + `body` (`createPolicyBodySchema`) |
| `GET /api/orgs/:orgId/policies` | `params` + `query` (`policyListQuerySchema`) |
| `GET /api/orgs/:orgId/policies/:ruleId` | `params` (`policyRulePathParamsSchema`) |
| `PATCH /api/orgs/:orgId/policies/:ruleId` | `params` + `body` (`updatePolicyBodySchema`) |
| `DELETE /api/orgs/:orgId/policies/:ruleId` | `params` (`policyRulePathParamsSchema`) |
| `GET /api/bond/:address` | `params` (`bondPathParamsSchema`) |

---

## Migration Guide (Remaining Routes)

To migrate any route that still uses ad-hoc validation:

### Step 1 – Create a schema (or reuse one from `src/schemas/`)

```ts
// src/schemas/myFeature.ts
import { z } from 'zod'

export const myParamsSchema = z.object({
  id: z.string().uuid(),
})

export const myBodySchema = z.object({
  name:   z.string().min(1).max(255),
  amount: z.number().positive(),
})

export type MyParams = z.infer<typeof myParamsSchema>
export type MyBody   = z.infer<typeof myBodySchema>
```

### Step 2 – Export from the barrel

```ts
// src/schemas/index.ts
export { myParamsSchema, myBodySchema, type MyParams, type MyBody } from './myFeature.js'
```

### Step 3 – Replace ad-hoc checks in the route

```diff
-router.post('/:id', (req, res) => {
-  if (!req.body.name) return res.status(400).json({ error: 'name required' })
-  const id = req.params.id
+import { validate, type ValidatedRequest } from '../middleware/validate.js'
+import { myParamsSchema, myBodySchema, type MyParams, type MyBody } from '../schemas/index.js'
+
+router.post(
+  '/:id',
+  validate({ params: myParamsSchema, body: myBodySchema }),
+  (req: ValidatedRequest<MyParams, any, MyBody>, res) => {
+    const { id }   = req.validated.params  // typed, no cast
+    const { name } = req.validated.body    // typed, no cast
```

### Step 4 – Test

```ts
it('rejects bad body with 400 uniform envelope', async () => {
  const res = await request(app).post('/api/my-route/valid-id').send({ amount: -1 })
  expect(res.status).toBe(400)
  expect(res.body.error_code).toBe('validation_failed')
  expect(res.body.details[0].code).toBe('value_too_small')
})
```

---

## Zod Version

This middleware requires **Zod v4** (`zod@^4.0.0`) and uses v4 issue codes
(`invalid_format`, `invalid_value`). Do not downgrade to v3.

---

## Testing the Middleware

```bash
# Run only middleware tests
npm test -- src/middleware/__tests__/validate.test.ts

# Coverage (must meet ≥95%)
npm run test:coverage -- src/middleware/__tests__/validate.test.ts
```
