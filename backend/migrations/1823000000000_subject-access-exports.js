/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable('subject_access_exports', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    subject_public_key: { type: 'varchar(255)', notNull: true },
    status: { type: 'varchar(16)', notNull: true, default: 'queued' },
    export_data: { type: 'jsonb' },
    source_errors: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    attempts: { type: 'integer', notNull: true, default: 0 },
    available_at: { type: 'timestamp', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
    started_at: { type: 'timestamp' },
    completed_at: { type: 'timestamp' },
    expires_at: { type: 'timestamp', notNull: true },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });
  pgm.addConstraint('subject_access_exports', 'subject_access_exports_status_check', {
    check: "status IN ('queued', 'processing', 'completed', 'failed', 'expired')",
  });
  pgm.createIndex('subject_access_exports', ['subject_public_key', 'created_at']);
  pgm.sql(`
    CREATE UNIQUE INDEX subject_access_exports_one_active_per_subject
      ON subject_access_exports (subject_public_key)
      WHERE status IN ('queued', 'processing');
  `);

  pgm.createTable('subject_access_export_audit', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },
    export_id: {
      type: 'uuid',
      references: 'subject_access_exports',
      onDelete: 'CASCADE',
    },
    subject_public_key: { type: 'varchar(255)', notNull: true },
    action: { type: 'varchar(24)', notNull: true },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });
  pgm.addConstraint(
    'subject_access_export_audit',
    'subject_access_export_audit_action_check',
    {
      check:
        "action IN ('requested', 'request_denied', 'generated', 'download_requested', 'downloaded', 'access_denied', 'retry_scheduled', 'failed', 'expired')",
    },
  );
  pgm.createIndex('subject_access_export_audit', ['subject_public_key', 'created_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('subject_access_export_audit');
  pgm.dropTable('subject_access_exports');
};
