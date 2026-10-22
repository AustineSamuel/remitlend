/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable('webhook_subscription_keys', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    subscription_id: {
      type: 'integer',
      notNull: true,
      references: 'webhook_subscriptions',
      onDelete: 'CASCADE',
    },
    ciphertext: { type: 'bytea', notNull: true },
    gcm_nonce: { type: 'bytea', notNull: true },
    dek_wrapped: { type: 'bytea', notNull: true },
    dek_kek_id: { type: 'varchar(255)', notNull: true },
    state: { type: 'varchar(16)', notNull: true },
    overlap_seconds: { type: 'integer' },
    idempotency_key: { type: 'varchar(128)' },
    overlap_expires_at: { type: 'timestamp' },
    verified_at: { type: 'timestamp' },
    retired_at: { type: 'timestamp' },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });
  pgm.addConstraint('webhook_subscription_keys', 'webhook_subscription_keys_state_check', {
    check: "state IN ('next', 'current', 'previous', 'retired')",
  });
  pgm.createIndex('webhook_subscription_keys', ['subscription_id', 'state']);
  pgm.createIndex('webhook_subscription_keys', ['subscription_id', 'idempotency_key'], {
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  });
  pgm.sql(`
    CREATE UNIQUE INDEX webhook_subscription_keys_one_current
      ON webhook_subscription_keys (subscription_id)
      WHERE state = 'current';
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX webhook_subscription_keys_one_previous
      ON webhook_subscription_keys (subscription_id)
      WHERE state = 'previous';
  `);

  pgm.addColumn('webhook_deliveries', {
    signing_key_id: { type: 'varchar(64)' },
  });
  pgm.addColumns('webhook_subscription_audit', {
    previous_signing_key_id: { type: 'uuid' },
    signing_key_id: { type: 'uuid' },
  });
  pgm.sql(`
    ALTER TABLE webhook_subscription_audit
      DROP CONSTRAINT webhook_subscription_audit_change_type_check;
    ALTER TABLE webhook_subscription_audit
      ADD CONSTRAINT webhook_subscription_audit_change_type_check
      CHECK (change_type IN ('created', 'updated', 'deleted', 'rotated', 'activated', 'rolled_back'));
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE webhook_subscription_audit
      DROP CONSTRAINT webhook_subscription_audit_change_type_check;
    ALTER TABLE webhook_subscription_audit
      ADD CONSTRAINT webhook_subscription_audit_change_type_check
      CHECK (change_type IN ('created', 'updated', 'deleted'));
  `);
  pgm.dropColumns('webhook_subscription_audit', [
    'previous_signing_key_id',
    'signing_key_id',
  ]);
  pgm.dropColumn('webhook_deliveries', 'signing_key_id');
  pgm.dropTable('webhook_subscription_keys');
};
