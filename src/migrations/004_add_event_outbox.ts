import type { Queryable } from '../db/repositories/queryable.js'
import { createOutboxSchema, dropOutboxSchema } from '../db/outbox/schema.js'

export async function up(db: Queryable): Promise<void> {
  await createOutboxSchema(db)
}

export async function down(db: Queryable): Promise<void> {
  await dropOutboxSchema(db)
}
