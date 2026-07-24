# Credence Database Schema

## Overview

The Credence protocol uses PostgreSQL. Two core tables are defined in the initial migrations:

| Table | Migration | Purpose |
|---|---|---|
| `identities` | `001_create_identities.sql` | On-chain wallet addresses registered in the protocol |
| `bonds` | `002_create_bonds.sql` | Staked/locked value tied to a registered identity |

A `schema_migrations` tracking table is also created by migration `001`.

---

## Tables

### `identities`

Stores every blockchain wallet address that has been registered with the Credence protocol.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `UUID` | NO | `gen_random_uuid()` | Surrogate primary key |
| `address` | `VARCHAR(255)` | NO | — | Blockchain wallet address (unique) |
| `created_at` | `TIMESTAMPTZ` | NO | `NOW()` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | NO | `NOW()` | Auto-updated by trigger on every `UPDATE` |

**Constraints**
- `PRIMARY KEY (id)`
- `UNIQUE (address)`

**Triggers**
- `identities_updated_at` – calls `set_updated_at()` before every `UPDATE`, keeping `updated_at` current automatically.

---

### `wallets`

Stores on-chain wallet balances managed by the protocol. Each wallet maps a blockchain address to a mutable balance.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `UUID` | NO | `gen_random_uuid()` | Surrogate primary key |
| `address` | `TEXT` | NO | — | Blockchain wallet address (unique) |
| `balance` | `NUMERIC(36,18)` | NO | `0` | Current balance; 36 total digits, 18 after the decimal point |
| `currency` | `TEXT` | NO | `'USD'` | Token/currency denomination |
| `created_at` | `TIMESTAMPTZ` | NO | `NOW()` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | NO | `NOW()` | Auto-updated on every `UPDATE` |

**Constraints**
- `PRIMARY KEY (id)`
- `UNIQUE (address)`
- `CHECK (balance >= 0)` — prevents negative balances at the database level

**Balance arithmetic**

All balance mutations use PostgreSQL `NUMERIC` arithmetic (`balance::NUMERIC ± $n::NUMERIC`) so no precision is lost in the database layer. The application layer (`WalletsRepository.debit()`) uses `compareDecimals()` from `src/lib/decimalMath.ts` — a BigInt-scaled exact comparison — for the sufficiency check. `Number()` is intentionally avoided: it loses precision beyond ~15 significant digits and can silently allow an overdraft on large or high-scale balances (e.g. `Number("10000000000000001") === Number("10000000000000002")`).

---

### `bonds`

Records staking/locking events. Each row represents one bond period for an identity.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `UUID` | NO | `gen_random_uuid()` | Surrogate primary key |
| `identity_id` | `UUID` | NO | — | FK → `identities.id` (CASCADE DELETE) |
| `bonded_amount` | `NUMERIC(36,18)` | NO | — | Total tokens bonded (18-decimal precision) |
| `bond_start` | `TIMESTAMPTZ` | NO | `NOW()` | When the bond period began |
| `bond_duration` | `INTERVAL` | NO | — | Length of the bond (e.g. `'30 days'`) |
| `bond_end` | `TIMESTAMPTZ` | NO | *(generated)* | Computed: `bond_start + bond_duration` |
| `slashed_amount` | `NUMERIC(36,18)` | NO | `0` | Cumulative slashed tokens |
| `active` | `BOOLEAN` | NO | `TRUE` | Whether the bond is still active |
| `created_at` | `TIMESTAMPTZ` | NO | `NOW()` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | NO | `NOW()` | Auto-updated by trigger |

**Constraints**
- `PRIMARY KEY (id)`
- `FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE CASCADE`
- `CHECK (bonded_amount >= 0)`
- `CHECK (slashed_amount >= 0)`
- `CHECK (slashed_amount <= bonded_amount)` — alias `slashed_lte_bonded`

**Indexes**
- `idx_bonds_identity_id` on `(identity_id)` — fast lookups by owner
- `idx_bonds_active` on `(identity_id) WHERE active = TRUE` — partial index for active-bond queries

**Triggers**
- `bonds_updated_at` – auto-refreshes `updated_at` on every `UPDATE`

---

## Entity Relationship

```
identities 1 ──< bonds
   id  ←────────── identity_id
```

Deleting an identity cascades to all of its bonds.

---

## Running Migrations

```bash
# Apply all migrations in order
psql $DATABASE_URL -f migrations/001_create_identities.sql
psql $DATABASE_URL -f migrations/002_create_bonds.sql

# Roll back migration 002
psql $DATABASE_URL -c "
  BEGIN;
  DROP TRIGGER IF EXISTS bonds_updated_at ON bonds;
  DROP INDEX  IF EXISTS idx_bonds_active;
  DROP INDEX  IF EXISTS idx_bonds_identity_id;
  DROP TABLE  IF EXISTS bonds;
  DELETE FROM schema_migrations WHERE version = '002_create_bonds';
  COMMIT;
"
```

All migrations are **idempotent** (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) so they can be re-run safely.

---

## Repository API

### `IdentityRepository`

| Method | Signature | Description |
|---|---|---|
| `findAll` | `(limit?, offset?) → Identity[]` | Paginated list, newest first |
| `findById` | `(id) → Identity \| null` | Lookup by UUID |
| `findByAddress` | `(address) → Identity \| null` | Lookup by wallet address |
| `create` | `(input) → Identity` | Insert; throws on duplicate address |
| `upsert` | `(input) → Identity` | Insert or refresh `updated_at` |
| `delete` | `(id) → boolean` | Hard delete; cascades to bonds |

### `BondRepository`

| Method | Signature | Description |
|---|---|---|
| `findByIdentityId` | `(identityId) → Bond[]` | All bonds for an identity |
| `findActiveBond` | `(identityId) → Bond \| null` | The single active bond |
| `findById` | `(id) → Bond \| null` | Lookup by UUID |
| `findExpired` | `() → Bond[]` | Active bonds past `bond_end` |
| `create` | `(input) → Bond` | Insert a new bond |
| `update` | `(id, input) → Bond \| null` | Partial update (`slashedAmount`, `active`) |
| `deactivate` | `(id) → boolean` | Sets `active = FALSE` |
| `delete` | `(id) → boolean` | Hard delete |
# Database Schema

This document describes the database schema for the Credence Backend.

## Overview

The schema models three core entities in the Credence trust protocol:

- **Identities** — on-chain addresses registered in the system.
- **Attestations** — verifier-issued trust signals linked to identities.
- **Slash Events** — penalty records for protocol violations.

## Entity Relationship

```
identities
  ├── 1:N ──► attestations
  └── 1:N ──► slash_events
```

Both `attestations` and `slash_events` hold a foreign key (`identity_id`) referencing `identities(id)` with `ON DELETE CASCADE`.

## Tables

### identities

| Column     | Type    | Constraints               | Description                 |
| ---------- | ------- | ------------------------- | --------------------------- |
| id         | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique identity ID          |
| address    | TEXT    | NOT NULL, UNIQUE          | On-chain address            |
| created_at | TEXT    | NOT NULL, DEFAULT now()   | ISO 8601 creation timestamp |

### attestations

| Column      | Type    | Constraints                   | Description                     |
| ----------- | ------- | ----------------------------- | ------------------------------- |
| id          | INTEGER | PRIMARY KEY AUTOINCREMENT     | Unique attestation ID           |
| verifier    | TEXT    | NOT NULL                      | Address of the verifier         |
| identity_id | INTEGER | NOT NULL, FK → identities(id) | The attested identity           |
| timestamp   | TEXT    | NOT NULL, DEFAULT now()       | When the attestation was issued |
| weight      | REAL    | NOT NULL, DEFAULT 1.0         | Attestation weight / strength   |
| revoked     | INTEGER | NOT NULL, DEFAULT 0           | 0 = active, 1 = revoked         |
| created_at  | TEXT    | NOT NULL, DEFAULT now()       | ISO 8601 creation timestamp     |

### slash_events

| Column       | Type    | Constraints                   | Description                         |
| ------------ | ------- | ----------------------------- | ----------------------------------- |
| id           | INTEGER | PRIMARY KEY AUTOINCREMENT     | Unique slash event ID               |
| identity_id  | INTEGER | NOT NULL, FK → identities(id) | The slashed identity                |
| amount       | TEXT    | NOT NULL                      | Slash amount (string for precision) |
| reason       | TEXT    | NOT NULL                      | Reason for the slash                |
| evidence_ref | TEXT    | NULLABLE                      | Reference to evidence (e.g. IPFS)   |
| timestamp    | TEXT    | NOT NULL, DEFAULT now()       | When the slash occurred             |
| created_at   | TEXT    | NOT NULL, DEFAULT now()       | ISO 8601 creation timestamp         |

## Migrations

Migrations are idempotent and use `CREATE TABLE IF NOT EXISTS`. They can be run safely multiple times.

To run migrations programmatically:

```typescript
import { createDatabase } from "./src/db/connection.js";
import { runMigrations } from "./src/db/migrations.js";

const db = createDatabase();
runMigrations(db);
```

## Notes

- **SQLite** is used as the initial database engine. The project is designed to migrate to PostgreSQL when the full architecture is implemented.
- **Foreign keys** are enforced via `PRAGMA foreign_keys = ON` set in the connection layer.
- **Cascade deletes** ensure that removing an identity also removes its attestations and slash events.
- **Amount as TEXT**: Slash event amounts are stored as strings to preserve precision for large numbers (e.g. wei values).
