import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("pg_stat_activity_snapshots", {
    snapshot_at: { type: "timestamptz", notNull: true },
    pid: { type: "integer", notNull: true },
    usename: { type: "text" },
    datname: { type: "text" },
    state: { type: "text" },
    query: { type: "text" },
    backend_type: { type: "text" },
    application_name: { type: "text" },
    client_addr: { type: "text" },
    wait_event_type: { type: "text" },
    wait_event: { type: "text" },
    backend_start: { type: "timestamptz" },
    xact_start: { type: "timestamptz" },
    query_start: { type: "timestamptz" },
    state_change: { type: "timestamptz" },
  });

  pgm.addConstraint(
    "pg_stat_activity_snapshots",
    "pg_stat_activity_snapshots_pkey",
    {
      primaryKey: ["snapshot_at", "pid"],
    },
  );

  pgm.createIndex("pg_stat_activity_snapshots", "snapshot_at");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("pg_stat_activity_snapshots");
}
