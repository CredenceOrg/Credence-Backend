import { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("score_history", {
    input_vector: { type: "jsonb", notNull: true, default: "'{}'::jsonb" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("score_history", "input_vector");
}
