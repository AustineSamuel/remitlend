/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable('notification_deliveries', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    notification_id: {
      type: 'integer',
      notNull: true,
      references: 'notifications',
      onDelete: 'CASCADE',
    },
    channel: { type: 'varchar(8)', notNull: true },
    provider: { type: 'varchar(32)', notNull: true },
    provider_message_id: { type: 'varchar(255)' },
    idempotency_key: { type: 'varchar(128)', notNull: true, unique: true },
    status: { type: 'varchar(24)', notNull: true, default: 'queued' },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    last_error_code: { type: 'varchar(64)' },
    next_attempt_at: { type: 'timestamp' },
    accepted_at: { type: 'timestamp' },
    delivered_at: { type: 'timestamp' },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
    updated_at: { type: 'timestamp', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });
  pgm.addConstraint('notification_deliveries', 'notification_deliveries_channel_check', {
    check: "channel IN ('email', 'sms')",
  });
  pgm.addConstraint('notification_deliveries', 'notification_deliveries_status_check', {
    check:
      "status IN ('queued', 'sending', 'accepted', 'delivered', 'retryable_failure', 'permanent_failure')",
  });
  pgm.addConstraint(
    'notification_deliveries',
    'notification_deliveries_notification_channel_unique',
    { unique: ['notification_id', 'channel'] },
  );
  pgm.createIndex('notification_deliveries', ['status', 'next_attempt_at']);
  pgm.createIndex('notification_deliveries', ['provider', 'provider_message_id'], {
    unique: true,
    where: 'provider_message_id IS NOT NULL',
  });
  pgm.createTable('notification_delivery_attempts', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    delivery_id: {
      type: 'uuid',
      notNull: true,
      references: 'notification_deliveries',
      onDelete: 'CASCADE',
    },
    attempt_number: { type: 'integer', notNull: true },
    provider: { type: 'varchar(32)', notNull: true },
    provider_message_id: { type: 'varchar(255)' },
    status: { type: 'varchar(24)', notNull: true },
    error_code: { type: 'varchar(64)' },
    accepted_at: { type: 'timestamp' },
    delivered_at: { type: 'timestamp' },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });
  pgm.addConstraint(
    'notification_delivery_attempts',
    'notification_delivery_attempts_status_check',
    {
      check:
        "status IN ('accepted', 'delivered', 'retryable_failure', 'permanent_failure')",
    },
  );
  pgm.addConstraint(
    'notification_delivery_attempts',
    'notification_delivery_attempts_number_unique',
    { unique: ['delivery_id', 'attempt_number'] },
  );
  pgm.createIndex(
    'notification_delivery_attempts',
    ['provider', 'provider_message_id'],
    { unique: true, where: 'provider_message_id IS NOT NULL' },
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('notification_delivery_attempts');
  pgm.dropTable('notification_deliveries');
};
