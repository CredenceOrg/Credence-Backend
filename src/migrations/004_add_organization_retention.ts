import { MigrationBuilder } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('organizations', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    name: {
      type: 'text',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  pgm.addConstraint('organizations', 'organizations_name_nonempty', {
    check: "length(trim(name)) > 0",
  })

  pgm.createTable('retention_policies', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    organization_id: {
      type: 'uuid',
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    scope_key: {
      type: 'text',
      notNull: true,
    },
    record_class: {
      type: 'text',
      notNull: true,
    },
    retention_days: {
      type: 'integer',
      notNull: true,
    },
    disposition: {
      type: 'text',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  pgm.addConstraint('retention_policies', 'retention_policies_scope_key_nonempty', {
    check: "length(trim(scope_key)) > 0",
  })
  pgm.addConstraint('retention_policies', 'retention_policies_record_class_check', {
    check: "record_class IN ('event', 'audit')",
  })
  pgm.addConstraint('retention_policies', 'retention_policies_retention_days_check', {
    check: 'retention_days > 0',
  })
  pgm.addConstraint('retention_policies', 'retention_policies_disposition_check', {
    check: "disposition IN ('archive', 'delete')",
  })
  pgm.createIndex('retention_policies', ['scope_key', 'record_class'], {
    name: 'retention_policies_scope_key_record_class_idx',
    unique: true,
  })
  pgm.createIndex('retention_policies', 'organization_id', {
    name: 'retention_policies_organization_id_idx',
  })

  pgm.createTable('retention_policy_changes', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    organization_id: {
      type: 'uuid',
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    record_class: {
      type: 'text',
      notNull: true,
    },
    previous_retention_days: {
      type: 'integer',
    },
    previous_disposition: {
      type: 'text',
    },
    new_retention_days: {
      type: 'integer',
      notNull: true,
    },
    new_disposition: {
      type: 'text',
      notNull: true,
    },
    changed_by: {
      type: 'text',
      notNull: true,
    },
    reason: {
      type: 'text',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  pgm.addConstraint('retention_policy_changes', 'retention_policy_changes_record_class_check', {
    check: "record_class IN ('event', 'audit')",
  })
  pgm.addConstraint('retention_policy_changes', 'retention_policy_changes_new_retention_days_check', {
    check: 'new_retention_days > 0',
  })
  pgm.addConstraint('retention_policy_changes', 'retention_policy_changes_new_disposition_check', {
    check: "new_disposition IN ('archive', 'delete')",
  })
  pgm.createIndex('retention_policy_changes', ['organization_id', { name: 'created_at', sort: 'DESC' }], {
    name: 'retention_policy_changes_organization_id_idx',
  })

  pgm.createTable('organization_event_records', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    organization_id: {
      type: 'uuid',
      notNull: true,
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    event_name: {
      type: 'text',
      notNull: true,
    },
    payload: {
      type: 'text',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })
  pgm.createIndex('organization_event_records', ['organization_id', 'created_at', 'id'], {
    name: 'organization_event_records_org_created_idx',
  })

  pgm.createTable('organization_event_record_archives', {
    id: {
      type: 'uuid',
      primaryKey: true,
    },
    organization_id: {
      type: 'uuid',
      notNull: true,
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    event_name: {
      type: 'text',
      notNull: true,
    },
    payload: {
      type: 'text',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
    },
    archived_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })
  pgm.createIndex('organization_event_record_archives', ['organization_id', 'created_at', 'id'], {
    name: 'organization_event_record_archives_org_created_idx',
  })

  pgm.createTable('organization_audit_records', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    organization_id: {
      type: 'uuid',
      notNull: true,
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    actor_id: {
      type: 'text',
      notNull: true,
    },
    action: {
      type: 'text',
      notNull: true,
    },
    details: {
      type: 'text',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })
  pgm.createIndex('organization_audit_records', ['organization_id', 'created_at', 'id'], {
    name: 'organization_audit_records_org_created_idx',
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('organization_audit_records')
  pgm.dropTable('organization_event_record_archives')
  pgm.dropTable('organization_event_records')
  pgm.dropTable('retention_policy_changes')
  pgm.dropTable('retention_policies')
  pgm.dropTable('organizations')
}
