import crypto from 'node:crypto';
import { query, withTransaction } from '../db/connection.js';
import logger from '../utils/logger.js';
import { getOutboundTraceparent } from '../utils/requestContext.js';
import { sendWebhookRequest } from './webhookEgress.js';
import {
  decryptWebhookSigningKey,
  retirePreviousWebhookKey,
  saveInitialWebhookKey,
  type WebhookSigningKey,
} from './webhookKeyRotationService.js';

// #1520 — this array is the single source of truth for which event types
// external webhook subscribers can register for. docs/webhooks.md's
// "Supported Event Types" section is a human-readable mirror of this list
// (kept manually in sync) — update both together whenever an entry is
// added, removed, or renamed here.
export const SUPPORTED_WEBHOOK_EVENT_TYPES = [
  'LoanRequested',
  'LoanApproved',
  'LoanRepaid',
  'LoanDefaulted',
  'CollateralLiquidated',
  'CollateralReturned',
  'CollateralDeposited',
  'CollateralReleased',
  'ColDep',
  'ColRel',
  'LateFeeCharged',
  'LoanExtended',
  'LoanCancelled',
  'LoanRejected',
  'LoanRefinanced',
  'InterestRateUpdated',
  'DefaultTermUpdated',
  'TermLimitsUpdated',
  'LateFeeRateUpdated',
  'GracePeriodUpdated',
  'DefaultWindowUpdated',
  'MaxLoanAmountUpdated',
  'MinRepaymentUpdated',
  'MaxLoansPerBorrower',
  'MinRateBpsUpdated',
  'MaxRateBpsUpdated',
  'RateOracleUpdated',
  'Deposit',
  'Withdraw',
  'YieldDistributed',
  'EmergencyWithdraw',
  'DepositCapUpdated',
  'WithdrawalCooldownUpdated',
  'NFTMinted',
  'ScoreUpdated',
  'NFTSeized',
  'NFTBurned',
  'NFTTransferred',
  'ProposalCreated',
  'ProposalApproved',
  'ProposalFinalized',
  'ProposalCancelled',
  'LoanApprv',
  'LoanLiquidated',
  // Legacy aliases kept to preserve compatibility for existing subscribers.
  'Mint',
  'ScoreUpd',
  'ScoreDecr',
  'Seized',
  'NftBurned',
  'AdmRemint',
  'HashUpd',
  'GovProp',
  'GovAppr',
  'GovFin',
  'Transfer',
  'MntAuth',
  'MntRev',
  'Paused',
  'Unpaused',
  'MinScoreUpdated',
  'PoolPaused',
  'PoolUnpaused',
  'GovCncl',
  'GovEmerg',
  'GovExp',
] as const;

export type WebhookEventType = (typeof SUPPORTED_WEBHOOK_EVENT_TYPES)[number];

export interface IndexedLoanEvent {
  eventId: string;
  eventType: WebhookEventType;
  loanId?: number;
  address?: string;
  amount?: string;
  interestRateBps?: number;
  termLedgers?: number;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  contractId: string;
  topics: string[];
  value: string;
}

export interface WebhookSubscription {
  id: number;
  ownerPublicKey: string;
  callbackUrl: string;
  eventTypes: WebhookEventType[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDelivery {
  id: number;
  subscriptionId: number;
  eventId: string;
  eventType: WebhookEventType;
  signingKeyId?: string;
  attemptCount: number;
  lastStatusCode?: number;
  lastError?: string;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface RegisterWebhookInput {
  callbackUrl: string;
  eventTypes: WebhookEventType[];
  secret?: string;
}

export interface RegisteredWebhookSubscription {
  subscription: WebhookSubscription;
  signingKey: WebhookSigningKey;
}

interface PreparedWebhookPayload {
  body: string;
  payload: Record<string, unknown>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getWebhookRequestTimeoutMs(): number {
  return parsePositiveInt(process.env.WEBHOOK_REQUEST_TIMEOUT_MS, 30 * 1000);
}

function getWebhookMaxPayloadBytes(): number {
  return parsePositiveInt(process.env.WEBHOOK_MAX_PAYLOAD_BYTES, 64 * 1024);
}

function summarizeOversizedPayload(
  payload: Record<string, unknown>,
  originalPayloadBytes: number,
  maxPayloadBytes: number,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    truncated: true,
    reason: 'payload_too_large',
    originalPayloadBytes,
    maxPayloadBytes,
  };

  const passthroughKeys = ['eventId', 'eventType', 'loanId', 'address', 'ledger'] as const;

  for (const key of passthroughKeys) {
    const value = payload[key];
    if (value !== undefined) {
      summary[key] = value;
    }
  }

  if (Array.isArray(payload.topics)) {
    summary.topicsCount = payload.topics.length;
  }

  return summary;
}

function summarizeOversizedPayloadMinimal(
  payload: Record<string, unknown>,
  originalPayloadBytes: number,
  maxPayloadBytes: number,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    truncated: true,
    reason: 'payload_too_large',
    originalPayloadBytes,
    maxPayloadBytes,
  };

  if (typeof payload.eventId === 'string') {
    summary.eventId = payload.eventId;
  }
  if (typeof payload.eventType === 'string') {
    summary.eventType = payload.eventType;
  }

  return summary;
}

function prepareWebhookPayload(payload: Record<string, unknown>): PreparedWebhookPayload {
  const body = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(body);
  const maxPayloadBytes = getWebhookMaxPayloadBytes();
  const eventId = typeof payload.eventId === 'string' ? payload.eventId : undefined;
  const eventType = typeof payload.eventType === 'string' ? payload.eventType : undefined;

  if (payloadBytes > maxPayloadBytes) {
    let summarizedPayload = summarizeOversizedPayload(payload, payloadBytes, maxPayloadBytes);
    let summarizedBody = JSON.stringify(summarizedPayload);

    if (Buffer.byteLength(summarizedBody) > maxPayloadBytes) {
      summarizedPayload = summarizeOversizedPayloadMinimal(payload, payloadBytes, maxPayloadBytes);
      summarizedBody = JSON.stringify(summarizedPayload);
    }

    if (Buffer.byteLength(summarizedBody) > maxPayloadBytes) {
      throw new Error(
        `Webhook summary payload exceeds configured limit of ${maxPayloadBytes} bytes`,
      );
    }

    logger.withContext().warn('Webhook payload exceeds size limit, sending summary payload', {
      eventId,
      eventType,
      payloadBytes,
      maxPayloadBytes,
    });

    return {
      body: summarizedBody,
      payload: summarizedPayload,
    };
  }

  if (payloadBytes >= Math.floor(maxPayloadBytes * 0.9)) {
    logger.withContext().warn('Webhook payload is near size limit', {
      eventId,
      eventType,
      payloadBytes,
      maxPayloadBytes,
    });
  }

  return {
    body,
    payload,
  };
}

async function postWebhook(
  callbackUrl: string,
  body: string,
  signature: string | undefined,
  identity?: { eventId?: string; generation?: number; signingKeyId?: string },
): Promise<Response> {
  const timeoutMs = getWebhookRequestTimeoutMs();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  timeoutHandle.unref?.();

  try {
    return await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Continue the retry's trace context into the subscriber's logs (#414).
        traceparent: getOutboundTraceparent(),
        // Stable identity for consumer-side deduplication (#517). The event ID
        // never changes across retries or operator re-drives; the generation
        // increments on each re-drive.
        ...(identity?.eventId && { 'x-remitlend-event-id': identity.eventId }),
        ...(identity?.generation !== undefined && {
          'x-remitlend-delivery-generation': String(identity.generation),
        }),
        ...(identity?.signingKeyId && { 'x-remitlend-key-id': identity.signingKeyId }),
        // X-RemitLend-Signature uses the GitHub/Stripe-style "sha256=<hex>"
        // format so subscribers can verify payload integrity (see
        // docs/wiki/webhook-signatures.md for the verification recipe).
        ...(signature && { 'x-remitlend-signature': `sha256=${signature}` }),
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Webhook request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Retry configuration for webhook delivery.
// This yields retry attempts at ~5m, ~15m, and ~45m after a failed delivery,
// for a total retry window a little over one hour after the initial attempt.
const RETRY_DELAYS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000] as const;

const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export const getRetryDelayMs = (attemptNumber: number): number => {
  const delayIndex = Math.max(0, Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1));
  return RETRY_DELAYS_MS[delayIndex] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
};

/**
 * Produces a short failure summary that is safe to store and expose to
 * operators: URLs, long tokens and anything past 200 chars are removed.
 */
export function redactFailureSummary(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
    .slice(0, 200);
}

export class WebhookService {
  // Retry processor that polls for pending retries
  static async processRetries(): Promise<void> {
    logger.withContext().info('Starting webhook retry processor');

    try {
      const now = new Date();
      const result = await query(
        `WITH expired_webhook_keys AS (
           UPDATE webhook_subscription_keys
           SET state = 'retired', retired_at = CURRENT_TIMESTAMP
           WHERE state = 'previous' AND overlap_expires_at <= CURRENT_TIMESTAMP
           RETURNING id
         )
         SELECT wd.id, wd.subscription_id, ws.callback_url, ws.secret, wd.event_id,
                wd.event_type, wd.payload, wd.attempt_count, wd.delivery_generation,
                sk.id AS signing_key_id, sk.ciphertext AS signing_key_ciphertext,
                sk.gcm_nonce AS signing_key_nonce,
                sk.dek_wrapped AS signing_key_wrapped_dek,
                sk.dek_kek_id AS signing_key_kek_id
         FROM webhook_deliveries wd
         JOIN webhook_subscriptions ws ON wd.subscription_id = ws.id
         LEFT JOIN webhook_subscription_keys sk
           ON sk.subscription_id = ws.id AND sk.state = 'current'
         WHERE wd.delivered_at IS NULL
           AND wd.next_retry_at IS NOT NULL
           AND wd.next_retry_at <= $1
           AND wd.attempt_count < $2
           AND wd.dead_lettered_at IS NULL
         ORDER BY wd.next_retry_at ASC
         LIMIT 100`,
        [now, MAX_RETRY_ATTEMPTS],
      );

      if (result.rows.length === 0) {
        logger.debug('No pending webhook retries');
        return;
      }

      logger.withContext().info(`Processing ${result.rows.length} pending webhook retries`);

      for (const row of result.rows) {
        const delivery = row as unknown as {
          id: number;
          subscription_id: number;
          callback_url: string;
          secret: string | null;
          event_id: string;
          event_type: string;
          payload: Record<string, unknown>;
          attempt_count: number;
          delivery_generation?: number;
        };
        // Defensive circuit breaker: the SQL filter above already excludes
        // deliveries at the retry ceiling, but guard here too so a delivery
        // at MAX_RETRY_ATTEMPTS is never re-sent even if it slips through.
        if (delivery.attempt_count >= MAX_RETRY_ATTEMPTS) {
          continue;
        }
        const signingKey = await decryptWebhookSigningKey(
          delivery as unknown as Record<string, unknown>,
          delivery.event_id,
        );
        await WebhookService.retryWebhookDelivery(
          delivery.id,
          delivery.subscription_id,
          delivery.callback_url,
          signingKey?.secret,
          delivery.event_id,
          delivery.event_type as WebhookEventType,
          delivery.payload,
          delivery.attempt_count,
          Number(delivery.delivery_generation ?? 1),
          signingKey?.keyId,
        );
      }
    } catch (error) {
      logger.withContext().error('Error in webhook retry processor', { error });
    }
  }

  public static async retryWebhookDelivery(
    deliveryId: number,
    subscriptionId: number,
    callbackUrl: string,
    secret: string | undefined,
    eventId: string,
    _eventType: WebhookEventType,
    payload: Record<string, unknown>,
    attemptCount: number,
    generation: number = 1,
    signingKeyId?: string,
  ): Promise<void> {
    const preparedPayload = prepareWebhookPayload(payload);
    const body = preparedPayload.body;

    const signature = secret
      ? crypto.createHmac('sha256', secret).update(body).digest('hex')
      : undefined;

    let response: Response | null = null;

    try {
      response = await postWebhook(callbackUrl, body, signature, {
        eventId,
        generation,
        ...(signingKeyId ? { signingKeyId } : {}),
      });

      if (
        response.ok &&
        signingKeyId &&
        response.headers?.get('x-remitlend-key-verified') === signingKeyId
      ) {
        await retirePreviousWebhookKey(subscriptionId, signingKeyId);
      }

      const successful = response.ok;
      const newAttemptCount = attemptCount + 1;

      if (successful) {
        // Mark as delivered
        await query(
          `UPDATE webhook_deliveries 
           SET attempt_count = $1, 
               last_status_code = $2, 
               delivered_at = $3,
               last_error = NULL,
               next_retry_at = NULL,
               updated_at = $4,
               signing_key_id = $6
           WHERE id = $5`,
          [newAttemptCount, response.status, new Date(), new Date(), deliveryId, signingKeyId ?? null],
        );

        logger.withContext().info('Webhook delivery succeeded after retry', {
          deliveryId,
          subscriptionId,
          eventId,
          attemptCount: newAttemptCount,
        });
      } else {
        // Schedule next retry or mark as permanently failed
        const nextRetryTime =
          newAttemptCount < MAX_RETRY_ATTEMPTS
            ? new Date(Date.now() + getRetryDelayMs(newAttemptCount))
            : null;

        const errorMsg = `Webhook returned status ${response.status}`;
        await query(
          `UPDATE webhook_deliveries 
           SET attempt_count = $1, 
               last_status_code = $2, 
               last_error = $3,
               next_retry_at = $4,
               updated_at = $5,
               dead_lettered_at = $7,
               dead_letter_reason = $8,
               signing_key_id = $9
           WHERE id = $6`,
          [
            newAttemptCount,
            response.status,
            errorMsg,
            nextRetryTime,
            new Date(),
            deliveryId,
            nextRetryTime ? null : new Date(),
            nextRetryTime ? null : redactFailureSummary(errorMsg),
            signingKeyId ?? null,
          ],
        );

        if (nextRetryTime) {
          logger.withContext().warn('Webhook delivery failed, scheduled retry', {
            deliveryId,
            subscriptionId,
            eventId,
            attemptCount: newAttemptCount,
            statusCode: response.status,
            nextRetryAt: nextRetryTime,
          });
        } else {
          logger.withContext().error('Webhook delivery permanently failed after max retries', {
            deliveryId,
            subscriptionId,
            eventId,
            attemptCount: newAttemptCount,
            statusCode: response.status,
            payload: body,
          });
        }
      }
    } catch (error) {
      const newAttemptCount = attemptCount + 1;
      const nextRetryTime =
        newAttemptCount < MAX_RETRY_ATTEMPTS
          ? new Date(Date.now() + getRetryDelayMs(newAttemptCount))
          : null;

      const errorMsg = error instanceof Error ? error.message : 'Unknown webhook error';

      await query(
        `UPDATE webhook_deliveries 
         SET attempt_count = $1, 
             last_error = $2,
             next_retry_at = $3,
             updated_at = $4,
             dead_lettered_at = $6,
             dead_letter_reason = $7,
             signing_key_id = $8
         WHERE id = $5`,
        [
          newAttemptCount,
          errorMsg,
          nextRetryTime,
          new Date(),
          deliveryId,
          nextRetryTime ? null : new Date(),
          nextRetryTime ? null : redactFailureSummary(errorMsg),
          signingKeyId ?? null,
        ],
      );

      if (nextRetryTime) {
        logger.withContext().warn('Webhook delivery error, scheduled retry', {
          deliveryId,
          subscriptionId,
          eventId,
          attemptCount: newAttemptCount,
          error,
          nextRetryAt: nextRetryTime,
        });
      } else {
        logger.withContext().error('Webhook delivery permanently failed after max retries', {
          deliveryId,
          subscriptionId,
          eventId,
          attemptCount: newAttemptCount,
          error,
        });
      }
    }
  }

  /**
   * Lists dead-lettered deliveries (retry exhausted, never delivered).
   * The payload is intentionally not returned; only identity and a redacted
   * failure summary are exposed.
   */
  static async listDeadLetters(limit: number = 50): Promise<Array<Record<string, unknown>>> {
    const result = await query(
      `SELECT id, subscription_id, event_id, event_type, attempt_count, delivery_generation,
              last_status_code, dead_letter_reason, dead_lettered_at,
              last_redriven_at, last_redriven_by
       FROM webhook_deliveries
       WHERE dead_lettered_at IS NOT NULL AND delivered_at IS NULL
       ORDER BY dead_lettered_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /**
   * Re-drives a dead-lettered delivery. Only the delivery ID is accepted: the
   * target URL comes from the stored subscription and the payload/event ID are
   * untouched. The state transition is a single conditional UPDATE so duplicate
   * or concurrent requests cannot both succeed.
   *
   * @returns the new generation, or null when the delivery is not dead-lettered.
   */
  static async redriveDeadLetter(
    deliveryId: number,
    actor: string,
  ): Promise<{ deliveryId: number; eventId: string; generation: number } | null> {
    const result = await query(
      `UPDATE webhook_deliveries
       SET dead_lettered_at = NULL,
           dead_letter_reason = NULL,
           attempt_count = 0,
           delivery_generation = delivery_generation + 1,
           next_retry_at = $2,
           last_redriven_at = $2,
           last_redriven_by = $3,
           updated_at = $2
       WHERE id = $1
         AND dead_lettered_at IS NOT NULL
         AND delivered_at IS NULL
       RETURNING id, event_id, delivery_generation`,
      [deliveryId, new Date(), actor],
    );

    const row = result.rows[0] as
      | { id: number; event_id: string; delivery_generation: number }
      | undefined;
    if (!row) return null;
    return {
      deliveryId: Number(row.id),
      eventId: String(row.event_id),
      generation: Number(row.delivery_generation),
    };
  }

  static isSupported(type: string): type is WebhookEventType {
    return SUPPORTED_WEBHOOK_EVENT_TYPES.includes(type as WebhookEventType);
  }

  async registerSubscription(
    ownerPublicKey: string,
    input: RegisterWebhookInput,
  ): Promise<RegisteredWebhookSubscription> {
    return withTransaction(async (client) => {
      const secret = input.secret ?? crypto.randomBytes(32).toString('hex');
      const result = await client.query(
        `INSERT INTO webhook_subscriptions
           (owner_public_key, callback_url, event_types, secret, is_active)
         VALUES ($1, $2, $3::jsonb, $4, true)
         RETURNING id, owner_public_key, callback_url, event_types, is_active,
                   created_at, updated_at`,
        [ownerPublicKey, input.callbackUrl, JSON.stringify(input.eventTypes), null],
      );
      const row = result.rows[0] as Record<string, unknown>;
      const keyId = await saveInitialWebhookKey(client, Number(row.id), secret);
      await client.query(
        `INSERT INTO webhook_subscription_audit
           (subscription_id, owner_public_key, change_type, callback_url, event_types,
            signing_key_id)
         VALUES ($1, $2, 'created', $3, $4::jsonb, $5)`,
        [row.id, ownerPublicKey, input.callbackUrl, JSON.stringify(input.eventTypes), keyId],
      );
      return {
        subscription: this.mapSubscriptionRow(row),
        signingKey: { keyId, secret },
      };
    });
  }

  async listSubscriptions(ownerPublicKey: string): Promise<WebhookSubscription[]> {
    const result = await query(
      `SELECT id, owner_public_key, callback_url, event_types, is_active,
              created_at, updated_at
       FROM webhook_subscriptions
       WHERE owner_public_key = $1
       ORDER BY created_at DESC`,
      [ownerPublicKey],
    );

    return result.rows.map((row) => this.mapSubscriptionRow(row as Record<string, unknown>));
  }

  async updateSubscription(
    id: number,
    ownerPublicKey: string,
    changes: Partial<Pick<RegisterWebhookInput, 'callbackUrl' | 'eventTypes'>>,
  ): Promise<WebhookSubscription | null> {
    return withTransaction(async (client) => {
      const selected = await client.query(
        `SELECT id, owner_public_key, callback_url, event_types, is_active,
                created_at, updated_at
         FROM webhook_subscriptions
         WHERE id = $1 AND owner_public_key = $2
         FOR UPDATE`,
        [id, ownerPublicKey],
      );
      const current = selected.rows[0] as Record<string, unknown> | undefined;
      if (!current) return null;

      const nextCallbackUrl = changes.callbackUrl ?? String(current.callback_url);
      const currentEventTypes = current.event_types as WebhookEventType[];
      const nextEventTypes = changes.eventTypes ?? currentEventTypes;
      if (
        nextCallbackUrl === current.callback_url &&
        JSON.stringify(nextEventTypes) === JSON.stringify(currentEventTypes)
      ) {
        return this.mapSubscriptionRow(current);
      }

      const result = await client.query(
        `UPDATE webhook_subscriptions
         SET callback_url = $1, event_types = $2::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND owner_public_key = $4
         RETURNING id, owner_public_key, callback_url, event_types, is_active,
                   created_at, updated_at`,
        [nextCallbackUrl, JSON.stringify(nextEventTypes), id, ownerPublicKey],
      );
      const updated = result.rows[0] as Record<string, unknown>;
      await client.query(
        `INSERT INTO webhook_subscription_audit
           (subscription_id, owner_public_key, change_type, previous_callback_url,
            callback_url, previous_event_types, event_types)
         VALUES ($1, $2, 'updated', $3, $4, $5::jsonb, $6::jsonb)`,
        [
          id,
          ownerPublicKey,
          current.callback_url,
          nextCallbackUrl,
          JSON.stringify(currentEventTypes),
          JSON.stringify(nextEventTypes),
        ],
      );
      return this.mapSubscriptionRow(updated);
    });
  }

  async deleteSubscription(id: number, ownerPublicKey: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const selected = await client.query(
        `SELECT callback_url, event_types, canceled_at
         FROM webhook_subscriptions
         WHERE id = $1 AND owner_public_key = $2
         FOR UPDATE`,
        [id, ownerPublicKey],
      );
      const current = selected.rows[0] as
        | { callback_url: string; event_types: WebhookEventType[]; canceled_at: Date | null }
        | undefined;
      if (!current) return false;
      if (current.canceled_at) return true;

      await client.query(
        `INSERT INTO webhook_subscription_audit
           (subscription_id, owner_public_key, change_type, previous_callback_url,
            previous_event_types)
         VALUES ($1, $2, 'deleted', $3, $4::jsonb)`,
        [id, ownerPublicKey, current.callback_url, JSON.stringify(current.event_types)],
      );
      await client.query(
        `UPDATE webhook_subscriptions
         SET is_active = false, canceled_at = COALESCE(canceled_at, CURRENT_TIMESTAMP),
             secret = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND owner_public_key = $2`,
        [id, ownerPublicKey],
      );
      await client.query(
        `DELETE FROM webhook_subscription_keys WHERE subscription_id = $1`,
        [id],
      );
      return true;
    });
  }

  async getSubscriptionAuditHistory(
    id: number,
    ownerPublicKey: string,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await query(
      `SELECT id, subscription_id, change_type, previous_callback_url, callback_url,
              previous_signing_key_id, signing_key_id,
              previous_event_types, event_types, created_at
       FROM webhook_subscription_audit
       WHERE subscription_id = $1 AND owner_public_key = $2
       ORDER BY created_at DESC, id DESC`,
      [id, ownerPublicKey],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async getSubscriptionDeliveries(
    subscriptionId: number,
    ownerPublicKey: string,
    limit: number = 50,
  ): Promise<WebhookDelivery[]> {
    const result = await query(
      `SELECT wd.id, wd.subscription_id, wd.event_id, wd.event_type, wd.signing_key_id,
              wd.attempt_count,
              wd.last_status_code, wd.last_error, wd.delivered_at, wd.created_at, wd.updated_at
       FROM webhook_deliveries wd
       JOIN webhook_subscriptions ws ON ws.id = wd.subscription_id
       WHERE wd.subscription_id = $1 AND ws.owner_public_key = $2
       ORDER BY wd.created_at DESC, wd.id DESC
       LIMIT $3`,
      [subscriptionId, ownerPublicKey, limit],
    );

    return result.rows.map((row) => this.mapDeliveryRow(row as Record<string, unknown>));
  }

  async dispatch(event: IndexedLoanEvent): Promise<void> {
    logger.withContext().info('Dispatching webhook event', {
      eventId: event.eventId,
      eventType: event.eventType,
      loanId: event.loanId,
      address: event.address,
    });

    try {
      const preparedPayload = prepareWebhookPayload(event as unknown as Record<string, unknown>);
      const webhooksResult = await query(
        `WITH expired_webhook_keys AS (
           UPDATE webhook_subscription_keys
           SET state = 'retired', retired_at = CURRENT_TIMESTAMP
           WHERE state = 'previous' AND overlap_expires_at <= CURRENT_TIMESTAMP
           RETURNING id
         )
         SELECT ws.id, ws.callback_url, ws.secret,
                sk.id AS signing_key_id, sk.ciphertext AS signing_key_ciphertext,
                sk.gcm_nonce AS signing_key_nonce,
                sk.dek_wrapped AS signing_key_wrapped_dek,
                sk.dek_kek_id AS signing_key_kek_id
         FROM webhook_subscriptions ws
         LEFT JOIN webhook_subscription_keys sk
           ON sk.subscription_id = ws.id AND sk.state = 'current'
         WHERE ws.is_active = true
           AND ws.owner_public_key IS NOT NULL
           AND ws.event_types @> $1::jsonb`,
        [JSON.stringify([event.eventType])],
      );

      await Promise.all(
        webhooksResult.rows.map(async (rawHook) => {
          const hook = rawHook as Record<string, unknown>;
          const signingKey = await decryptWebhookSigningKey(hook, event.eventId);
          await this.sendToWebhook(
            Number(hook.id),
            String(hook.callback_url),
            signingKey,
            preparedPayload,
          );
        }),
      );
    } catch (error) {
      logger.withContext().error('Error during webhook dispatch', {
        eventId: event.eventId,
        eventType: event.eventType,
        error,
      });
    }
  }

  private async sendToWebhook(
    subscriptionId: number,
    callbackUrl: string,
    signingKey: WebhookSigningKey | null,
    payload: PreparedWebhookPayload,
  ): Promise<void> {
    const body = payload.body;

    const signature = signingKey
      ? crypto.createHmac('sha256', signingKey.secret).update(body).digest('hex')
      : undefined;

    try {
      const response = await postWebhook(callbackUrl, body, signature, {
        eventId: String(payload.payload.eventId),
        generation: 1,
        ...(signingKey ? { signingKeyId: signingKey.keyId } : {}),
      });

      if (
        response.ok &&
        signingKey &&
        response.headers?.get('x-remitlend-key-verified') === signingKey.keyId
      ) {
        await retirePreviousWebhookKey(subscriptionId, signingKey.keyId);
      }

      const successful = response.ok;

      if (successful) {
        // Delivery succeeded, mark as delivered
        await query(
          `INSERT INTO webhook_deliveries (
            subscription_id,
            event_id,
            event_type,
            attempt_count,
            last_status_code,
            delivered_at,
            payload,
            next_retry_at,
            signing_key_id
          )
          VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, NULL, $7)`,
          [
            subscriptionId,
            payload.payload.eventId,
            payload.payload.eventType,
            response.status,
            new Date(),
            body,
            signingKey?.keyId ?? null,
          ],
        );
      } else {
        // Delivery failed, schedule first retry
        const nextRetryAt = new Date(Date.now() + getRetryDelayMs(1));
        await query(
          `INSERT INTO webhook_deliveries (
            subscription_id,
            event_id,
            event_type,
            attempt_count,
            last_status_code,
            last_error,
            payload,
            next_retry_at,
            signing_key_id
          )
          VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, $7, $8)`,
          [
            subscriptionId,
            payload.payload.eventId,
            payload.payload.eventType,
            response.status,
            `Webhook returned status ${response.status}`,
            body,
            nextRetryAt,
            signingKey?.keyId ?? null,
          ],
        );

        logger.withContext().warn('Webhook delivery failed, scheduled retry', {
          subscriptionId,
          callbackUrl,
          eventId: payload.payload.eventId,
          statusCode: response.status,
          nextRetryAt,
        });
      }
    } catch (error) {
      // Network error or timeout, schedule first retry
      const nextRetryAt = new Date(Date.now() + getRetryDelayMs(1));
      await query(
        `INSERT INTO webhook_deliveries (
          subscription_id,
          event_id,
          event_type,
          attempt_count,
          last_error,
          payload,
          next_retry_at,
          signing_key_id
        )
        VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6, $7)`,
        [
          subscriptionId,
          payload.payload.eventId,
          payload.payload.eventType,
          error instanceof Error ? error.message : 'Unknown webhook error',
          body,
          nextRetryAt,
          signingKey?.keyId ?? null,
        ],
      );

      logger.withContext().error('Failed to send webhook, scheduled retry', {
        subscriptionId,
        callbackUrl,
        eventId: payload.payload.eventId,
        error,
        nextRetryAt,
      });
    }
  }

  private mapSubscriptionRow(row: Record<string, unknown>): WebhookSubscription {
    return {
      id: Number(row.id),
      ownerPublicKey: String(row.owner_public_key),
      callbackUrl: String(row.callback_url),
      eventTypes: (row.event_types as WebhookEventType[]) ?? [],
      isActive: Boolean(row.is_active),
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
    };
  }

  private mapDeliveryRow(row: Record<string, unknown>): WebhookDelivery {
    const lastStatusCode =
      typeof row.last_status_code === 'number'
        ? row.last_status_code
        : row.last_status_code !== null && row.last_status_code !== undefined
          ? Number(row.last_status_code)
          : undefined;

    const lastError =
      typeof row.last_error === 'string' && row.last_error.length > 0 ? row.last_error : undefined;

    const deliveredAt = row.delivered_at ? new Date(String(row.delivered_at)) : undefined;

    return {
      id: Number(row.id),
      subscriptionId: Number(row.subscription_id),
      eventId: String(row.event_id),
      eventType: String(row.event_type) as WebhookEventType,
      ...(typeof row.signing_key_id === 'string' ? { signingKeyId: row.signing_key_id } : {}),
      attemptCount: Number(row.attempt_count ?? 1),
      ...(lastStatusCode !== undefined ? { lastStatusCode } : {}),
      ...(lastError ? { lastError } : {}),
      ...(deliveredAt ? { deliveredAt } : {}),
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
    };
  }
}

export const webhookService = new WebhookService();
