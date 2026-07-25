# Regenerating the OpenAPI Spec

This document describes how the OpenAPI specification (`docs/openapi.yaml`) is generated, how to regenerate it after making changes, and how to verify the result.

**Audience:** Contributors adding or modifying API endpoints.

---

## Quick reference

```bash
# Regenerate the spec from current Zod schemas
npm run generate:openapi

# Verify the spec matches registered routes
npx tsx scripts/openapi-drift.js
```

---

## How it works

The OpenAPI spec is **not hand-written**. It is generated programmatically from the Zod schemas in `src/schemas/` using [`@asteasolutions/zod-to-openapi`](https://github.com/asteasolutions/zod-to-openapi).

The generation script is `scripts/generate-openapi.ts`. It:

1. Imports all schemas from `src/schemas/index.ts`.
2. Registers each schema as an OpenAPI component via `registry.registerComponent()`.
3. Registers each route with its request/response schemas via `registry.registerPath()`.
4. Generates the OpenAPI 3.0.0 document.
5. Writes the result to `docs/openapi.yaml`.

### Key files

| File | Purpose |
|------|---------|
| `scripts/generate-openapi.ts` | Generation script — all route registrations live here |
| `src/schemas/index.ts` | Barrel export for all Zod schemas |
| `src/schemas/*.ts` | Individual schema modules (trust, bond, attestations, etc.) |
| `docs/openapi.yaml` | The generated output (checked in, do not edit by hand) |
| `scripts/openapi-drift.js` | Drift detector that compares registered routes against the spec |

---

## Regenerating the spec

After any change to Zod schemas or route registrations, run:

```bash
npm run generate:openapi
```

This overwrites `docs/openapi.yaml` with a fresh copy. The command is deterministic — running it twice with the same input produces identical output.

### When to regenerate

Regenerate the spec whenever you:

- **Add a new endpoint** — register it in `scripts/generate-openapi.ts` and add its Zod schemas in `src/schemas/`.
- **Modify a request or response shape** — update the Zod schema, then regenerate.
- **Remove an endpoint** — remove the registration from `scripts/generate-openapi.ts` and regenerate.

---

## Adding a new endpoint

### Step 1 — Define Zod schemas

Create or extend a schema file in `src/schemas/`. For example, to add a new `GET /api/widgets/:id` endpoint:

```ts
// src/schemas/widgets.ts
import { z } from 'zod';

export const widgetParamsSchema = z.object({
  id: z.string().uuid(),
});

export const widgetResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string().datetime(),
});
```

Export the new schemas from `src/schemas/index.ts`.

### Step 2 — Register the route

Open `scripts/generate-openapi.ts` and add a `registry.registerPath()` call:

```ts
import * as schemas from '../src/schemas/index.js';

registry.registerPath({
  method: 'get',
  path: '/api/widgets/{id}',
  summary: 'Get a widget',
  description: 'Returns a single widget by ID.',
  tags: ['Widgets'],
  request: { params: schemas.widgetParamsSchema },
  responses: {
    200: {
      description: 'Widget found',
      content: { 'application/json': { schema: schemas.widgetResponseSchema } },
    },
    404: {
      description: 'Widget not found',
      content: { 'application/json': { schema: z.any() } },
    },
  },
});
```

### Step 3 — Register the route in the drift detector

Add the route to the `routes` array in `scripts/openapi-drift.js`:

```js
{ path: '/api/widgets/:id', method: 'get' },
```

Note the drift detector uses Express-style `:param` syntax, while the OpenAPI generator uses `{param}` syntax.

### Step 4 — Regenerate and verify

```bash
npm run generate:openapi
npx tsx scripts/openapi-drift.js
```

Both commands must pass before pushing.

---

## Drift detection

`scripts/openapi-drift.js` compares the routes registered in its `getRegisteredRoutes()` function against the paths present in `docs/openapi.yaml`.

The script **exits non-zero** if:

- A route in the code is missing from the spec (you forgot to regenerate).
- A route in the spec does not exist in the code (stale spec or orphaned registration).
- The spec file is empty or malformed.

Admin routes under `/api/admin/*` are excluded from the public contract check.

### Running locally

```bash
npx tsx scripts/openapi-drift.js
```

Expected output on success:

```
✅ No OpenAPI contract drift detected. All routes match spec.
```

---

## Viewing the generated spec

```bash
# Preview with Redocly
npx @redocly/cli preview-docs docs/openapi.yaml

# Or paste into https://editor.swagger.io
```

---

## Pre-push checklist

Before pushing any PR that touches API routes or schemas:

1. Run `npm run generate:openapi` to regenerate `docs/openapi.yaml`.
2. Run `npx tsx scripts/openapi-drift.js` to confirm no drift.
3. Run `npx tsc --noEmit` to verify TypeScript compiles.
4. Run `npm test` to verify tests pass.
5. Run `npm run lint` to verify linting passes.
6. Run `npm run security:scan` and `npm run sbom:check` if the PR adds new dependencies.

---

## Related docs

- [API reference](api.md) — full endpoint documentation with cURL examples
- [Schema conventions](schema.md) — how Zod schemas are structured in this project
- [Contributing & Testing](CONTRIBUTING-TESTING.md) — full test suite walkthrough
