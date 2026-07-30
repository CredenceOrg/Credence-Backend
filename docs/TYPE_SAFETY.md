# End-to-End Type Safety: Zod → OpenAPI → Frontend Client

**Audience:** backend and frontend contributors adding or modifying an API endpoint.

The Credence backend uses a three-layer pipeline to enforce type safety from the
database to the client:

1. **Zod schemas** define and validate request/response shapes at the runtime edge.
2. **OpenAPI spec** is generated from those schemas for documentation and contract testing.
3. **Frontend client types** are derived from the OpenAPI spec so the client never
   sends a payload the server will reject.

```
src/schemas/<resource>.ts   (Zod schema — single source of truth)
        │
        ▼
scripts/generate-openapi.ts (zod-to-openapi — extracts OpenAPI spec)
        │
        ▼
docs/openapi.yaml           (published OpenAPI 3.0 spec)
        │
        ▼
<frontend>                  (openapi-typescript / openapi-generator — typed client)
```

---

## 1. Zod Schemas (source of truth)

Every request body, query string, path param, and response body has a Zod schema
in `src/schemas/<resource>.ts`. The schema is the single source of truth — it is
used for runtime validation **and** OpenAPI generation.

### Anatomy of a schema file

```ts
// src/schemas/credits.ts
import { z } from '../schemas/openapi.js'  // ← extended z with .openapi()

// Request body
export const creditTransferBodySchema = z.object({
  from: stellarAddressSchema,
  to: stellarAddressSchema,
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
  memo: z.string().max(28).optional(),
}).strict()

export type CreditTransferBody = z.infer<typeof creditTransferBodySchema>

// Response body
export const creditTransferResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    txHash: z.string(),
    status: z.enum(['pending', 'confirmed', 'failed']),
  }),
})

export type CreditTransferResponse = z.infer<typeof creditTransferResponseSchema>
```

### Rules

- **Import `z` from `src/schemas/openapi.ts`**, not from `zod` directly. The
  `openapi.ts` module calls `extendZodWithOpenApi(z)` once, which adds the
  `.openapi()` method to every Zod type. Schemas imported bare from `zod` will
  not appear in the generated OpenAPI spec.
- **Export `z.infer<...>` types** for every schema. Consumers (middleware,
  services, tests) import the type, not the raw schema, when they only need
  compile-time checking.
- **Use `.strict()`** on body schemas to reject unknown fields.
- **Use `.openapi({ description: '...' })`** on fields that need additional
  documentation beyond the type constraint.

---

## 2. Validation Middleware

The `validate` middleware (`src/middleware/validate.ts`) takes one or more Zod
schemas and applies them at the request edge:

```ts
// src/routes/credits.ts
router.post('/transfer',
  requireApiKey(ApiScope.TRUSTED),
  validate({ body: creditTransferBodySchema }),
  async (req, res) => {
    const { from, to, amount, memo } = req.validated!.body! as CreditTransferBody
    //                                                    ^^^^^^^^^^^^^^^^
    // req.validated is typed — no need to cast inside the handler
  },
)
```

### What happens at runtime

| Scenario | Status | Body |
|----------|--------|------|
| Valid body | 200 / 201 | Handler runs with typed data |
| Missing field | 400 | `{ "error": "Validation failed", "details": [{ "path": "amount", "message": "Required" }] }` |
| Extra field (`.strict()`) | 400 | `{ "error": "Validation failed", "details": [{ "path": "memo", "message": "Unrecognized key" }] }` |
| Wrong type | 400 | `{ "error": "Validation failed", "details": [{ "path": "amount", "message": "Expected string, received number" }] }` |

---

## 3. OpenAPI Generation

The script `scripts/generate-openapi.ts` uses
[`@asteasolutions/zod-to-openapi`](https://github.com/asteasolutions/zod-to-openapi)
to translate every registered schema into an OpenAPI 3.0 component.

### How schemas are registered

All schemas exported from `src/schemas/index.ts` are automatically registered as
OpenAPI components. Additional endpoint metadata (path, method, tags, responses)
is registered via `registry.registerPath()`.

```ts
// scripts/generate-openapi.ts
registry.registerPath({
  method: 'post',
  path: '/api/credits/transfer',
  summary: 'Transfer credits between accounts',
  tags: ['Credits'],
  request: {
    body: {
      content: { 'application/json': { schema: schemas.creditTransferBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Transfer submitted',
      content: { 'application/json': { schema: schemas.creditTransferResponseSchema } },
    },
  },
})
```

### Generate the spec

```bash
npm run generate:openapi
```

Output: `docs/openapi.yaml`

### CI gate

CI runs a drift check to ensure the checked-in `docs/openapi.yaml` matches what
the generator produces. If they differ, the pipeline fails with instructions to
re-run `npm run generate:openapi`. This prevents stale specs.

---

## 4. Frontend Client

The published `docs/openapi.yaml` is consumed by frontend tooling to produce
typed API clients.

### Option A: openapi-typescript (recommended for TypeScript clients)

```bash
npx openapi-typescript docs/openapi.yaml -o ../frontend/src/lib/api/types.ts
```

Generates a single `.ts` file with:

```ts
// ../frontend/src/lib/api/types.ts
export interface paths {
  '/api/credits/transfer': {
    post: {
      requestBody: { content: { 'application/json': components['schemas']['creditTransferBodySchema'] } }
      responses: { 200: { content: { 'application/json': components['schemas']['creditTransferResponseSchema'] } } }
    }
  }
}
```

### Option B: openapi-generator (multi-language)

```bash
npx @openapitools/openapi-generator-cli generate \
  -i docs/openapi.yaml \
  -g typescript-fetch \
  -o ../frontend/src/lib/api/generated
```

### Version pinning

The frontend should pin to a specific API version or commit SHA to avoid
breaking when the backend deploys a backward-incompatible change. The backend's
`/api/version` endpoint returns `gitSha` and `buildTimestamp` for
cross-referencing.

---

## 5. Response Validation (optional)

For endpoints where correctness is critical (settlements, credits), the
`validateResponse` middleware (`src/middleware/validateResponse.ts`) asserts
that the **outgoing response body** also conforms to its schema:

```ts
router.post('/credits/transfer', ..., async (req, res) => {
  const result = await creditService.transfer(req.validated!.body!)
  res.json(result)
}, validateResponse(creditTransferResponseSchema))
```

If the response shape ever drifts from the schema (e.g., a new field is added to
the service response but not to the schema), the middleware logs a warning and
returns a 500. This catches schema/implementation skew before it reaches clients.

Enabled only in non-production environments by default.

---

## Adding a new endpoint (checklist)

1. Define the request and response Zod schemas in `src/schemas/<resource>.ts`.
2. Export `z.infer<...>` types for each schema.
3. Register the endpoint in `scripts/generate-openapi.ts` via `registry.registerPath()`.
4. Wire the schemas in the route handler with the `validate` middleware.
5. Run `npm run generate:openapi` to regenerate `docs/openapi.yaml`.
6. Regenerate the frontend client types from the updated `docs/openapi.yaml`.
7. Add route tests that exercise the validation edge cases (missing field,
   wrong type, extra field).

---

## Related docs

- [docs/OPENAPI.md](OPENAPI.md) — OpenAPI spec conventions
- [docs/VALIDATION.md](VALIDATION.md) — the validate middleware in detail
- [docs/api/bond.md](api/bond.md) — example resource with full schema contract
