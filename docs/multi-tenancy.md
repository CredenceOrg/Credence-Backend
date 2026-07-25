Tenant Isolation

Goal: Enforce `tenant_id` row-level isolation across core tables using Postgres RLS and a per-transaction `app.tenant_id` session setting.

What changed

- New migration: `src/migrations/007_add_tenant_id_and_rls.ts` — adds `tenant_id` uuid column and enables RLS policies on core tables.
- Tenant context helper: `src/utils/tenantContext.ts` — AsyncLocalStorage-based helper to propagate tenant id across async call chains.
- Transaction propagation: `src/db/transaction.ts` — sets `SET LOCAL app.tenant_id = '<tenant>'` at transaction start when a tenant is present.
- Auth middleware: `src/middleware/auth.ts` — authenticated requests are run within the tenant async context.

Testing checklist (step-by-step)

1. Build and run migrations locally (ensure `DATABASE_URL` is set):

```bash
npm run build
DATABASE_URL=postgres://user:pass@localhost:5432/credence npm run migrate
```

2. Start services (Docker recommended):

```bash
docker compose up --build
```

3. Verify the new columns exist and RLS is enabled:

```bash
psql $DATABASE_URL -c "\\d+ identities"
psql $DATABASE_URL -c "SELECT relrowsecurity FROM pg_class WHERE relname = 'identities'"
```

4. Run unit tests:

```bash
npm test
```

5. Manual verification of tenant enforcement:

Use `psql` and simulate two sessions with different `app.tenant_id` values and confirm queries only return rows for that tenant:

```sql
BEGIN;
SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000001';
SELECT * FROM identities; -- should only show rows for tenant 000...1
ROLLBACK;

BEGIN;
SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000';
SELECT * FROM identities; -- sentinel/backfilled rows
ROLLBACK;
```

Notes

- Existing rows are backfilled with the sentinel tenant id `00000000-0000-0000-0000-000000000000`; update them to real tenant ids as part of migration planning if needed.
- Repositories and application code are expected to run requests inside the tenant context (middleware sets this for authenticated users). Background jobs or admin tooling must set a tenant explicitly using `runWithTenant` from `src/utils/tenantContext.ts`.
