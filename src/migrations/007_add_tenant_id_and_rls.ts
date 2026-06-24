import { MigrationBuilder } from "node-pg-migrate";

const TABLES = [
  "identities",
  "bonds",
  "attestations",
  "slash_events",
  "score_history",
];

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add tenant_id column (nullable initially to allow backfill)
  for (const t of TABLES) {
    pgm.addColumn(t, {
      tenant_id: { type: "uuid" },
    });
  }

  // Backfill existing rows to a sentinel tenant id so migration is safe.
  // Consumers should update existing rows to the appropriate tenant if needed.
  const sentinel = "00000000-0000-0000-0000-000000000000";
  for (const t of TABLES) {
    pgm.sql(
      `UPDATE ${t} SET tenant_id = '${sentinel}' WHERE tenant_id IS NULL`,
    );
    pgm.alterColumn(t, "tenant_id", { notNull: true });
    pgm.createIndex(t, "tenant_id");
  }

  // Enable row level security and create tenant-isolation policies.
  for (const t of TABLES) {
    pgm.sql(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`
      CREATE POLICY tenant_isolation_${t} ON ${t}
      USING (
        current_setting('app.tenant_id', true) IS NOT NULL
        AND tenant_id = current_setting('app.tenant_id', true)::uuid
      )
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    `);
  }

  // Deny by default via no other policies. Tests/ops can set app.tenant_id before
  // running statements; application transaction manager will set the local setting.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  for (const t of TABLES) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation_${t} ON ${t}`);
    pgm.sql(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
    pgm.dropIndex(t, "tenant_id");
    pgm.dropColumn(t, "tenant_id");
  }
}
