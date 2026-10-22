import crypto from 'node:crypto';
import type { PoolClient } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';

const DEFAULT_MAX_OVERLAP_SECONDS = 24 * 60 * 60;

export interface WebhookSigningKey {
  keyId: string;
  secret: string;
}

async function encryptWebhookSecret(secret: string) {
  const { encryptField } = await import('./piiCrypto.js');
  return encryptField(secret);
}

export interface WebhookKeyRotationResult {
  keyId: string;
  secret?: string;
  overlapExpiresAt?: Date;
  replayed: boolean;
}

export class WebhookKeyRotationError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'overlap_in_progress'
      | 'invalid_overlap'
      | 'not_pending',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookKeyRotationError';
  }
}

export function getMaxWebhookKeyOverlapSeconds(): number {
  const configured = Number.parseInt(process.env.WEBHOOK_MAX_KEY_OVERLAP_SECONDS ?? '', 10);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_OVERLAP_SECONDS;
}

export async function saveInitialWebhookKey(
  client: PoolClient,
  subscriptionId: number,
  secret: string,
): Promise<string> {
  const keyId = crypto.randomUUID();
  const encrypted = await encryptWebhookSecret(secret);
  await client.query(
    `INSERT INTO webhook_subscription_keys
       (id, subscription_id, ciphertext, gcm_nonce, dek_wrapped, dek_kek_id, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'current')`,
    [
      keyId,
      subscriptionId,
      encrypted.ciphertext,
      encrypted.gcm_nonce,
      encrypted.dek_wrapped,
      encrypted.dek_kek_id,
    ],
  );
  return keyId;
}

export async function decryptWebhookSigningKey(
  row: Record<string, unknown>,
  eventId: string,
): Promise<WebhookSigningKey | null> {
  if (
    typeof row.signing_key_id !== 'string' ||
    !Buffer.isBuffer(row.signing_key_ciphertext) ||
    !Buffer.isBuffer(row.signing_key_nonce) ||
    !Buffer.isBuffer(row.signing_key_wrapped_dek) ||
    typeof row.signing_key_kek_id !== 'string'
  ) {
    const legacySecret = typeof row.secret === 'string' ? row.secret : '';
    if (legacySecret.length === 0) return null;
    return {
      keyId: `legacy-${String(row.subscription_id ?? row.id)}`,
      secret: legacySecret,
    };
  }

  const { decryptField } = await import('./piiCrypto.js');
  const subscriptionId = String(row.subscription_id ?? row.id);
  const secret = await decryptField(
    subscriptionId,
    'webhook_signing_key',
    row.signing_key_ciphertext,
    row.signing_key_nonce,
    row.signing_key_wrapped_dek,
    row.signing_key_kek_id,
    'system:webhook-delivery',
    'Sign outgoing webhook delivery',
    eventId,
  );

  return { keyId: row.signing_key_id, secret };
}

export async function rotateWebhookSigningKey(
  subscriptionId: number,
  ownerPublicKey: string,
  idempotencyKey: string,
  overlapSeconds = getMaxWebhookKeyOverlapSeconds(),
): Promise<WebhookKeyRotationResult> {
  const maxOverlapSeconds = getMaxWebhookKeyOverlapSeconds();
  if (
    !Number.isSafeInteger(overlapSeconds) ||
    overlapSeconds < 1 ||
    overlapSeconds > maxOverlapSeconds
  ) {
    throw new WebhookKeyRotationError(
      'invalid_overlap',
      `overlapSeconds must be between 1 and ${maxOverlapSeconds}`,
    );
  }

  return withTransaction(async (client) => {
    const subscriptionResult = await client.query(
      `SELECT id, secret
       FROM webhook_subscriptions
       WHERE id = $1 AND owner_public_key = $2
       FOR UPDATE`,
      [subscriptionId, ownerPublicKey],
    );
    const subscription = subscriptionResult.rows[0] as
      | { id: number; secret: string | null }
      | undefined;
    if (!subscription) {
      throw new WebhookKeyRotationError('not_found', 'Webhook subscription not found');
    }

    const replay = await client.query(
      `SELECT id
       FROM webhook_subscription_keys
       WHERE subscription_id = $1 AND idempotency_key = $2`,
      [subscriptionId, idempotencyKey],
    );
    const replayedKey = replay.rows[0] as
      | { id: string }
      | undefined;
    if (replayedKey) {
      return {
        keyId: replayedKey.id,
        replayed: true,
      };
    }

    await client.query(
      `UPDATE webhook_subscription_keys
       SET state = 'retired', retired_at = CURRENT_TIMESTAMP
       WHERE subscription_id = $1
         AND state = 'previous'
         AND overlap_expires_at <= CURRENT_TIMESTAMP`,
      [subscriptionId],
    );
    const stagedResult = await client.query(
      `SELECT id
       FROM webhook_subscription_keys
       WHERE subscription_id = $1 AND state = 'next'
       LIMIT 1`,
      [subscriptionId],
    );
    const previousResult = await client.query(
      `SELECT id
       FROM webhook_subscription_keys
       WHERE subscription_id = $1 AND state = 'previous'
       LIMIT 1`,
      [subscriptionId],
    );
    if (stagedResult.rows.length > 0 || previousResult.rows.length > 0) {
      throw new WebhookKeyRotationError(
        'overlap_in_progress',
        'A webhook signing-key rotation or overlap is already in progress',
      );
    }

    const currentResult = await client.query(
      `SELECT id FROM webhook_subscription_keys
       WHERE subscription_id = $1 AND state = 'current'
       FOR UPDATE`,
      [subscriptionId],
    );
    const current = currentResult.rows[0] as { id: string } | undefined;
    const newSecret = crypto.randomBytes(32).toString('hex');
    const newKeyId = crypto.randomUUID();
    const encrypted = await encryptWebhookSecret(newSecret);

    if (!current && subscription.secret) {
      const legacyKeyId = crypto.randomUUID();
      const legacyEncrypted = await encryptWebhookSecret(subscription.secret);
      await client.query(
        `INSERT INTO webhook_subscription_keys
           (id, subscription_id, ciphertext, gcm_nonce, dek_wrapped, dek_kek_id, state)
         VALUES ($1, $2, $3, $4, $5, $6, 'current')`,
        [
          legacyKeyId,
          subscriptionId,
          legacyEncrypted.ciphertext,
          legacyEncrypted.gcm_nonce,
          legacyEncrypted.dek_wrapped,
          legacyEncrypted.dek_kek_id,
        ],
      );
      await client.query(
        `UPDATE webhook_subscriptions SET secret = NULL WHERE id = $1`,
        [subscriptionId],
      );
    }

    await client.query(
      `INSERT INTO webhook_subscription_keys
         (id, subscription_id, ciphertext, gcm_nonce, dek_wrapped, dek_kek_id,
          state, idempotency_key, overlap_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, 'next', $7, $8)`,
      [
        newKeyId,
        subscriptionId,
        encrypted.ciphertext,
        encrypted.gcm_nonce,
        encrypted.dek_wrapped,
        encrypted.dek_kek_id,
        idempotencyKey,
        overlapSeconds,
      ],
    );
    await client.query(
      `INSERT INTO webhook_subscription_audit
         (subscription_id, owner_public_key, change_type, previous_signing_key_id, signing_key_id)
       VALUES ($1, $2, 'rotated', $3, $4)`,
      [subscriptionId, ownerPublicKey, current?.id ?? null, newKeyId],
    );

    return {
      keyId: newKeyId,
      secret: newSecret,
      replayed: false,
    };
  });
}

export async function activateWebhookSigningKey(
  subscriptionId: number,
  ownerPublicKey: string,
  keyId: string,
): Promise<{ keyId: string; overlapExpiresAt?: Date; replayed: boolean }> {
  return withTransaction(async (client) => {
    const subscription = await client.query(
      `SELECT id FROM webhook_subscriptions
       WHERE id = $1 AND owner_public_key = $2
       FOR UPDATE`,
      [subscriptionId, ownerPublicKey],
    );
    if (subscription.rows.length === 0) {
      throw new WebhookKeyRotationError('not_found', 'Webhook subscription not found');
    }

    const nextResult = await client.query(
      `SELECT id, overlap_seconds
       FROM webhook_subscription_keys
       WHERE id = $1 AND subscription_id = $2 AND state = 'next'
       FOR UPDATE`,
      [keyId, subscriptionId],
    );
    const next = nextResult.rows[0] as { id: string; overlap_seconds: number | null } | undefined;
    if (!next) {
      const current = await client.query(
        `SELECT id FROM webhook_subscription_keys
         WHERE id = $1 AND subscription_id = $2 AND state = 'current'`,
        [keyId, subscriptionId],
      );
      if (current.rows.length > 0) return { keyId, replayed: true };
      throw new WebhookKeyRotationError('not_pending', 'Signing key is not awaiting activation');
    }

    await client.query(
      `UPDATE webhook_subscription_keys
       SET state = 'retired', retired_at = CURRENT_TIMESTAMP
       WHERE subscription_id = $1
         AND state = 'previous'
         AND overlap_expires_at <= CURRENT_TIMESTAMP`,
      [subscriptionId],
    );
    const currentResult = await client.query(
      `SELECT id
       FROM webhook_subscription_keys
       WHERE subscription_id = $1 AND state = 'current'
       FOR UPDATE`,
      [subscriptionId],
    );
    const current = currentResult.rows[0] as { id: string } | undefined;
    const overlapExpiresAt = current
      ? new Date(Date.now() + Number(next.overlap_seconds) * 1000)
      : undefined;
    if (current) {
      await client.query(
        `UPDATE webhook_subscription_keys
         SET state = 'previous', overlap_expires_at = $1
         WHERE id = $2`,
        [overlapExpiresAt, current.id],
      );
    }
    await client.query(
      `UPDATE webhook_subscription_keys
       SET state = 'current', overlap_expires_at = NULL
       WHERE id = $1`,
      [keyId],
    );
    await client.query(
      `INSERT INTO webhook_subscription_audit
         (subscription_id, owner_public_key, change_type, previous_signing_key_id, signing_key_id)
       VALUES ($1, $2, 'activated', $3, $4)`,
      [subscriptionId, ownerPublicKey, current?.id ?? null, keyId],
    );

    return {
      keyId,
      ...(overlapExpiresAt ? { overlapExpiresAt } : {}),
      replayed: false,
    };
  });
}

export async function rollbackWebhookSigningKey(
  subscriptionId: number,
  ownerPublicKey: string,
  keyId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const subscription = await client.query(
      `SELECT id FROM webhook_subscriptions
       WHERE id = $1 AND owner_public_key = $2
       FOR UPDATE`,
      [subscriptionId, ownerPublicKey],
    );
    if (subscription.rows.length === 0) {
      throw new WebhookKeyRotationError('not_found', 'Webhook subscription not found');
    }

    const pending = await client.query(
      `SELECT id
       FROM webhook_subscription_keys
       WHERE id = $1 AND subscription_id = $2 AND state = 'next'
       FOR UPDATE`,
      [keyId, subscriptionId],
    );
    if (pending.rows.length === 0) {
      const rolledBack = await client.query(
        `SELECT id
         FROM webhook_subscription_keys
         WHERE id = $1 AND subscription_id = $2 AND state = 'retired'
           AND idempotency_key IS NOT NULL`,
        [keyId, subscriptionId],
      );
      if (rolledBack.rows.length > 0) return;
      throw new WebhookKeyRotationError('not_pending', 'Only a pending signing key can be rolled back');
    }

    await client.query(
      `UPDATE webhook_subscription_keys
       SET state = 'retired', retired_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = 'next'`,
      [keyId],
    );
    await client.query(
      `INSERT INTO webhook_subscription_audit
         (subscription_id, owner_public_key, change_type, signing_key_id)
       VALUES ($1, $2, 'rolled_back', $3)`,
      [subscriptionId, ownerPublicKey, keyId],
    );
  });
}

export async function retirePreviousWebhookKey(
  subscriptionId: number,
  currentKeyId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const current = await client.query(
      `SELECT id
       FROM webhook_subscription_keys
       WHERE id = $1 AND subscription_id = $2 AND state = 'current'
       FOR UPDATE`,
      [currentKeyId, subscriptionId],
    );
    if (current.rows.length === 0) return;
    await client.query(
      `UPDATE webhook_subscription_keys
       SET state = 'retired', verified_at = CURRENT_TIMESTAMP, retired_at = CURRENT_TIMESTAMP
       WHERE subscription_id = $1 AND state = 'previous'`,
      [subscriptionId],
    );
  });
}
