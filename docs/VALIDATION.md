# Request Validation

Request validation is implemented with **Zod** schemas and a reusable **validate** middleware. Invalid path params, query params, or body are rejected with **400** and a clear list of errors.

## Middleware

- **Location:** `src/middleware/validate.ts`
- **Function:** `validate(options)` — accepts optional `params`, `query`, and `body` Zod schemas.
- **Success:** Sets `req.validated` with typed `params`, `query`, and/or `body` and calls `next()`.
- **Failure:** Sends `400` with body:
  ```json
  {
    "error": "Validation failed",
    "details": [
      { "path": "address", "message": "Address must be a valid 0x-prefixed 40-character hex string" }
    ]
  }
  ```

## Usage

Apply per route as needed (public and protected):

```ts
import { validate } from './middleware/validate.js'
import { trustPathParamsSchema } from './schemas/index.js'

app.get('/api/trust/:address', validate({ params: trustPathParamsSchema }), (req, res) => {
  const { address } = req.validated!.params!
  // address is validated and typed
})
```

- **Path params:** Use `validate({ params: schema })` for `:address` etc.
- **Query:** Use `validate({ query: schema })` for `?limit=10&offset=0`.
- **Body:** Use `validate({ body: schema })` for POST/PUT JSON.

You can combine them: `validate({ params: schemaA, query: schemaB, body: schemaC })`.

## Schemas

- **Address:** `src/schemas/address.ts` — `0x` + 40 hex chars (e.g. Ethereum-style).
- **Trust:** `src/schemas/trust.ts` — path params for `/api/trust/:address`.
- **Bond:** `src/schemas/bond.ts` — path params for `/api/bond/:address`.
- **Attestations:** `src/schemas/attestations.ts` — path, query (limit/offset), and body (create).

Import from `src/schemas/index.js` for a single entry point.

## Tests

- **Middleware:** `src/middleware/validate.test.ts` — unit tests for success/failure and 400 shape.
- **Schemas:** `src/schemas/*.test.ts` — valid/invalid address, missing fields, query/body.
- **API:** `src/api.test.ts` — integration tests for valid/invalid address, missing body fields, invalid query.

Run tests and coverage:

```bash
npm run test
npm run test:coverage
```

Target: minimum 95% test coverage (statement/line).
