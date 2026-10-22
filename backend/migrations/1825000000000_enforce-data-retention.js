/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable('retention_job_state', {
    data_class: { type: 'varchar(64)', primaryKey: true },
    last_run_id: { type: 'uuid' },
    last_started_at: { type: 'timestamptz' },
    last_completed_at: { type: 'timestamptz' },
    last_processed_count: { type: 'integer', notNull: true, default: 0 },
    last_error_code: { type: 'varchar(64)' },
  });

  pgm.createTable('retention_job_runs', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'varchar(16)', notNull: true, default: 'running' },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
    completed_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('retention_job_runs', 'retention_job_runs_status_check', {
    check: "status IN ('running', 'completed', 'partial', 'failed')",
  });
  pgm.createIndex('retention_job_runs', ['started_at', 'id']);

  pgm.createTable('retention_job_lease', {
    id: { type: 'integer', primaryKey: true },
    token: { type: 'uuid' },
    lease_until: { type: 'timestamptz' },
  });
  pgm.addConstraint('retention_job_lease', 'retention_job_lease_singleton_check', {
    check: 'id = 1',
  });
  pgm.sql('INSERT INTO retention_job_lease (id) VALUES (1)');

  pgm.createTable('retention_job_run_classes', {
    run_id: {
      type: 'uuid',
      notNull: true,
      references: 'retention_job_runs',
      onDelete: 'CASCADE',
    },
    data_class: { type: 'varchar(64)', notNull: true },
    cutoff_at: { type: 'timestamptz', notNull: true },
    operation_counts: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    affected_count: { type: 'integer', notNull: true, default: 0 },
    status: { type: 'varchar(16)', notNull: true },
    error_code: { type: 'varchar(64)' },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });
  pgm.addConstraint('retention_job_run_classes', 'retention_job_run_classes_status_check', {
    check: "status IN ('completed', 'partial', 'failed')",
  });
  pgm.addConstraint('retention_job_run_classes', 'retention_job_run_classes_run_class_unique', {
    unique: ['run_id', 'data_class'],
  });

  pgm.createTable('retention_legal_holds', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    data_class: { type: 'varchar(64)', notNull: true },
    record_id: { type: 'varchar(255)', notNull: true },
    basis: { type: 'text', notNull: true },
    created_by: { type: 'varchar(255)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
    released_by: { type: 'varchar(255)' },
    released_at: { type: 'timestamptz' },
    release_basis: { type: 'text' },
  });
  pgm.addConstraint('retention_legal_holds', 'retention_legal_holds_release_check', {
    check:
      '(released_at IS NULL AND released_by IS NULL AND release_basis IS NULL) OR ' +
      '(released_at IS NOT NULL AND released_by IS NOT NULL AND release_basis IS NOT NULL)',
  });
  pgm.sql(`
    CREATE UNIQUE INDEX retention_legal_holds_one_active_record
      ON retention_legal_holds (data_class, record_id)
      WHERE released_at IS NULL
  `);
  pgm.createIndex('retention_legal_holds', ['data_class', 'record_id', 'released_at']);

  pgm.createTable('retention_legal_hold_audit', {
    id: { type: 'bigserial', primaryKey: true },
    hold_id: {
      type: 'uuid',
      notNull: true,
      references: 'retention_legal_holds',
      onDelete: 'CASCADE',
    },
    action: { type: 'varchar(16)', notNull: true },
    actor: { type: 'varchar(255)', notNull: true },
    basis: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });
  pgm.addConstraint('retention_legal_hold_audit', 'retention_legal_hold_audit_action_check', {
    check: "action IN ('created', 'released')",
  });

  pgm.createTable('retention_cache_invalidations', {
    id: { type: 'bigserial', primaryKey: true },
    cache_kind: { type: 'varchar(32)', notNull: true },
    subject_key: { type: 'varchar(255)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
    attempts: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint(
    'retention_cache_invalidations',
    'retention_cache_invalidations_kind_check',
    {
      check:
        "cache_kind IN ('borrower_loans', 'score_response', 'score_breakdown', " +
        "'legacy_score_response', 'legacy_score_breakdown')",
    },
  );
  pgm.createIndex('retention_cache_invalidations', ['next_attempt_at', 'id']);

  pgm.addColumn('contract_events', {
    retention_deleted_at: { type: 'timestamptz' },
  });
  pgm.createIndex('contract_events', ['retention_deleted_at', 'created_at']);
  pgm.addColumn('remittances', {
    retention_anonymized_at: { type: 'timestamptz' },
  });
  pgm.alterColumn('remittances', 'recipient_address', { notNull: false });
  pgm.alterColumn('remittances', 'xdr', { notNull: false });
  pgm.createIndex('remittances', ['created_at', 'id']);
  pgm.createIndex('subject_access_exports', ['expires_at', 'id']);
  pgm.createIndex('subject_access_export_audit', ['export_id', 'created_at']);
  pgm.createIndex('webhook_subscription_audit', ['subscription_id', 'created_at']);
  pgm.addColumn('webhook_subscriptions', {
    canceled_at: { type: 'timestamptz' },
  });
  pgm.createIndex('webhook_subscriptions', ['canceled_at', 'id']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropIndex('webhook_subscription_audit', ['subscription_id', 'created_at']);
  pgm.dropIndex('subject_access_export_audit', ['export_id', 'created_at']);
  pgm.dropIndex('retention_job_runs', ['started_at', 'id']);
  pgm.dropIndex('webhook_subscriptions', ['canceled_at', 'id']);
  pgm.dropColumn('webhook_subscriptions', 'canceled_at');
  pgm.dropIndex('subject_access_exports', ['expires_at', 'id']);
  pgm.dropIndex('remittances', ['created_at', 'id']);
  pgm.dropColumn('remittances', 'retention_anonymized_at');
  pgm.dropIndex('contract_events', ['retention_deleted_at', 'created_at']);
  pgm.dropColumn('contract_events', 'retention_deleted_at');
  pgm.dropTable('retention_cache_invalidations');
  pgm.dropTable('retention_legal_hold_audit');
  pgm.dropTable('retention_legal_holds');
  pgm.dropTable('retention_job_run_classes');
  pgm.dropTable('retention_job_lease');
  pgm.dropTable('retention_job_runs');
  pgm.dropTable('retention_job_state');
};
