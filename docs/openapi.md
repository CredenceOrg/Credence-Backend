# Runtime OpenAPI and Swagger UI

The backend serves a runtime-generated OpenAPI document.

## Endpoints

- `GET /api-docs/openapi.json` → OpenAPI JSON
- `GET /api-docs` → Swagger UI

## Source of truth

- Specification builder: `src/openapi/spec.ts`
- Docs routes: `src/routes/docs.ts`

The static file `docs/openapi.yaml` is now a compatibility placeholder with a pointer to the runtime source of truth.

## Keeping spec in sync

Route/spec synchronization is enforced by tests:

- `src/openapi/spec.test.ts` checks required paths and schema contracts.
- `src/routes/docs.test.ts` checks served docs behavior.
