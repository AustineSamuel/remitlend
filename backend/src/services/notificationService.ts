import { query, withTransaction } from '../db/connection.js';
import logger from '../utils/logger.js';
import type { Response } from 'express';
import {
  notificationDeliveryFailuresCounter,
  notificationDeliveryLagHistogram,
} from '../middleware/metrics.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationType =
  | 'loan_approved'
  | 'repayment_due'
  | 'repayment_confirmed'
  | 'loan_defaulted'
  | 'loan_liquidated'
  | 'score_changed';

export type NotificationStatus = 'unread' | 'read' | 'archived';

export interface Notification {
  id: number;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  loanId?: number | undefined;
  actionUrl?: string | null;
  read: boolean;
  status: NotificationStatus;
  createdAt: Date;
}

interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  loanId?: number | undefined;
  actionUrl?: string | undefined | null;
}

export interface NotificationPreferences {
  emailEnabled: boolean;
  smsEnabled: boolean;
  phone: string | null;
  perTypeOverrides: Record<string, boolean>;
  digestFrequency?: 'off' | 'daily' | 'weekly';
}

// ─── SSE subscriber registry ──────────────────────────────────────────────────
// Maps userId → set of SSE response streams currently listening.
// No persistence needed — streams are in-process only.

type SseClient = Response;
const sseClients = new Map<string, Set<SseClient>>();

// Lazy-init Twilio client — dynamic import avoids ESM/CJS interop issues in tests
async function getTwilioClient() {
  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN ||
    !process.env.TWILIO_PHONE_NUMBER
  ) {
    return null;
  }
  const { default: twilio } = await import('twilio');
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Lazy-init SendGrid — called once on first sendEmail
let _sgInitialized = false;
async function ensureSendGrid() {
  if (_sgInitialized) return;
  _sgInitialized = true;
  if (process.env.SENDGRID_API_KEY) {
    const sgMail = await import('@sendgrid/mail');
    sgMail.default.setApiKey(process.env.SENDGRID_API_KEY);
  }
}

function buildEmailTemplate(
  type: NotificationType,
  message: string,
): { subject: string; html: string } {
  const templates: Record<NotificationType, { subject: string; html: string }> = {
    loan_approved: {
      subject: 'Your loan has been approved — RemitLend',
      html: `<h2>Loan Approved</h2><p>${message}</p><p>Log in to view your loan details and repayment schedule.</p>`,
    },
    repayment_due: {
      subject: 'Repayment reminder — RemitLend',
      html: `<h2>Repayment Due Soon</h2><p>${message}</p><p>Please ensure funds are available to avoid a default.</p>`,
    },
    repayment_confirmed: {
      subject: 'Repayment confirmed — RemitLend',
      html: `<h2>Repayment Confirmed</h2><p>${message}</p><p>Thank you for your payment.</p>`,
    },
    loan_defaulted: {
      subject: 'Loan default notice — RemitLend',
      html: `<h2>Loan Defaulted</h2><p>${message}</p><p>Contact support immediately if you believe this is an error.</p>`,
    },
    loan_liquidated: {
      subject: 'Your loan has been liquidated — RemitLend',
      html: `<h2>Loan Liquidated</h2><p>${message}</p><p>Contact support if you have questions about the outcome.</p>`,
    },
    score_changed: {
      subject: 'Your credit score has changed — RemitLend',
      html: `<h2>Credit Score Update</h2><p>${message}</p><p>Log in to see your updated score and history.</p>`,
    },
  };

  return templates[type];
}

type NotificationChannel = 'email' | 'sms';
type FailureClass = 'retryable' | 'permanent';

interface ProviderOutcome {
  status: 'accepted' | 'retryable_failure' | 'permanent_failure';
  provider: 'sendgrid' | 'twilio';
  providerMessageId?: string;
  errorCode?: string;
}

function classifyProviderError(error: unknown): {
  failureClass: FailureClass;
  errorCode: string;
} {
  const providerError = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  const rawStatus = Number(providerError?.statusCode ?? providerError?.status);
  const errorCode =
    typeof providerError?.code === 'string'
      ? providerError.code.slice(0, 64)
      : Number.isFinite(rawStatus)
        ? `HTTP_${rawStatus}`
        : 'PROVIDER_ERROR';
  const retryable =
    rawStatus === 408 ||
    rawStatus === 429 ||
    rawStatus >= 500 ||
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'].includes(errorCode) ||
    (!Number.isFinite(rawStatus) && providerError?.code == null);
  return { failureClass: retryable ? 'retryable' : 'permanent', errorCode };
}

export function getNotificationRetryDelayMs(attempt: number, random = Math.random): number {
  const baseDelays = [30_000, 120_000, 600_000, 1_800_000] as const;
  const base = baseDelays[Math.max(0, Math.min(attempt - 1, baseDelays.length - 1))]!;
  return Math.round(Math.min(60 * 60 * 1000, base * (0.5 + random())));
}

async function sendEmail(
  email: string,
  message: string,
  type?: NotificationType,
  notificationId?: number,
  deliveryId?: string,
): Promise<ProviderOutcome> {
  const fromEmail = process.env.FROM_EMAIL;
  if (!fromEmail) {
    return { status: 'permanent_failure', provider: 'sendgrid', errorCode: 'CONFIG_MISSING' };
  }

  try {
    await ensureSendGrid();
    if (!process.env.SENDGRID_API_KEY) {
      return { status: 'permanent_failure', provider: 'sendgrid', errorCode: 'CONFIG_MISSING' };
    }

    const template = type
      ? buildEmailTemplate(type, message)
      : { subject: 'Notification from RemitLend', html: `<p>${message}</p>` };
    const sgMail = await import('@sendgrid/mail');
    const response = await sgMail.default.send({
      to: email,
      from: fromEmail,
      subject: template.subject,
      html: template.html,
      customArgs: {
        remitlend_notification_id: String(notificationId ?? ''),
        remitlend_delivery_id: deliveryId ?? '',
      },
    });
    const headers = response?.[0]?.headers as Record<string, string> | undefined;
    return {
      status: 'accepted',
      provider: 'sendgrid',
      ...(headers?.['x-message-id'] ? { providerMessageId: headers['x-message-id'] } : {}),
    };
  } catch (error) {
    const classified = classifyProviderError(error);
    return {
      status: classified.failureClass === 'retryable' ? 'retryable_failure' : 'permanent_failure',
      provider: 'sendgrid',
      errorCode: classified.errorCode,
    };
  }
}

async function sendSMS(phone: string, message: string): Promise<ProviderOutcome> {
  try {
    const twilioClient = await getTwilioClient();
    if (!twilioClient || !process.env.TWILIO_PHONE_NUMBER) {
      return { status: 'permanent_failure', provider: 'twilio', errorCode: 'CONFIG_MISSING' };
    }
    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });
    return {
      status: 'accepted',
      provider: 'twilio',
      ...(result.sid ? { providerMessageId: result.sid } : {}),
    };
  } catch (error) {
    const classified = classifyProviderError(error);
    return {
      status: classified.failureClass === 'retryable' ? 'retryable_failure' : 'permanent_failure',
      provider: 'twilio',
      errorCode: classified.errorCode,
    };
  }
}

class NotificationService {
  async getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
    const result = await query(
      `SELECT email_enabled, sms_enabled, phone
       FROM user_profiles
       WHERE public_key = $1
       LIMIT 1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return {
        emailEnabled: false,
        smsEnabled: false,
        phone: null,
        perTypeOverrides: {},
      };
    }

    const row = result.rows[0];
    return {
      emailEnabled: Boolean(row.email_enabled),
      smsEnabled: Boolean(row.sms_enabled),
      phone: (row.phone as string | null) ?? null,
      perTypeOverrides: {},
    };
  }

  async updateNotificationPreferences(
    userId: string,
    payload: Pick<NotificationPreferences, 'emailEnabled' | 'smsEnabled' | 'phone'>,
  ): Promise<NotificationPreferences> {
    const result = await query(
      `UPDATE user_profiles
       SET email_enabled = $2,
           sms_enabled = $3,
           phone = $4
       WHERE public_key = $1
       RETURNING email_enabled, sms_enabled, phone`,
      [userId, payload.emailEnabled, payload.smsEnabled, payload.phone],
    );

    const row = result.rows[0] ?? {
      email_enabled: payload.emailEnabled,
      sms_enabled: payload.smsEnabled,
      phone: payload.phone,
    };

    return {
      emailEnabled: Boolean(row.email_enabled),
      smsEnabled: Boolean(row.sms_enabled),
      phone: (row.phone as string | null) ?? null,
      perTypeOverrides: {},
    };
  }

  /**
   * Persists a new notification and pushes it to any active SSE subscribers
   * for that user.
   */
  async createNotification(params: CreateNotificationParams): Promise<Notification> {
    const { userId, type, title, message, loanId, actionUrl } = params;

    const resolvedActionUrl = actionUrl ?? (loanId != null ? `/loans/${loanId}` : null);

    const result = await query(
      `INSERT INTO notifications (user_id, type, title, message, loan_id, action_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'unread')
       RETURNING id, user_id, type, title, message, loan_id, action_url, read, status, created_at`,
      [userId, type, title, message, loanId ?? null, resolvedActionUrl],
    );

    const notification = this.mapRow(result.rows[0]);
    this.broadcast(userId, notification);

    // Also trigger external notifications
    await this.notifyUserExternal(notification.id, userId, message, type);

    return notification;
  }

  /**
   * Batches repayment_due notifications per user based on digest frequency.
   * Returns grouped notifications by user and digest frequency.
   */
  async batchRepaymentNotificationsForDigest(
    notifications: Array<{ userId: string; message: string; loanId?: number }>,
  ): Promise<Map<string, Array<{ userId: string; message: string; loanId?: number }>>> {
    const grouped = new Map<string, Array<{ userId: string; message: string; loanId?: number }>>();

    for (const notif of notifications) {
      const prefResult = await query(
        `SELECT digest_frequency FROM user_notification_preferences WHERE user_id = $1`,
        [notif.userId],
      );

      const digestFrequency = prefResult.rows[0]?.digest_frequency ?? 'off';

      if (digestFrequency === 'off') {
        // Send immediately
        const key = `${notif.userId}:immediate`;
        if (!grouped.has(key)) {
          grouped.set(key, []);
        }
        grouped.get(key)!.push(notif);
      } else {
        // Batch for daily or weekly digest
        const key = `${notif.userId}:${digestFrequency}`;
        if (!grouped.has(key)) {
          grouped.set(key, []);
        }
        grouped.get(key)!.push(notif);
      }
    }

    return grouped;
  }

  /**
   * Sends external notifications (Email/SMS) based on user preferences.
   * SMS is triggered for repayment_due and loan_defaulted events.
   */
  private async notifyUserExternal(
    notificationId: number,
    userId: string,
    message: string,
    type: NotificationType,
  ) {
    try {
      const result = await query(
        `SELECT email, phone, email_enabled, sms_enabled
         FROM user_profiles WHERE public_key = $1 LIMIT 1`,
        [userId],
      );

      if (result.rows.length === 0) return;

      const notification = result.rows[0];
      if (notification.email_enabled && notification.email) {
        const deliveryId = await this.queueDelivery(notificationId, 'email', 'sendgrid');
        if (deliveryId) {
          await this.attemptDelivery(
            deliveryId,
            notificationId,
            userId,
            'email',
            notification.email as string,
            message,
            type,
          );
        }
      }

      const smsEnabledForType =
        type === 'repayment_due' || type === 'loan_defaulted' || type === 'loan_liquidated';

      if (notification.sms_enabled && notification.phone && smsEnabledForType) {
        const deliveryId = await this.queueDelivery(notificationId, 'sms', 'twilio');
        if (deliveryId) {
          await this.attemptDelivery(
            deliveryId,
            notificationId,
            userId,
            'sms',
            notification.phone as string,
            message,
            type,
          );
        }
      }
    } catch (error) {
      logger.withContext().error('Error sending external notifications', { error });
    }
  }

  private async queueDelivery(
    notificationId: number,
    channel: NotificationChannel,
    provider: 'sendgrid' | 'twilio',
  ): Promise<string | null> {
    const result = await query(
      `INSERT INTO notification_deliveries
         (notification_id, channel, provider, idempotency_key, status)
       VALUES ($1, $2, $3, $4, 'queued')
       ON CONFLICT (notification_id, channel) DO NOTHING
       RETURNING id`,
      [notificationId, channel, provider, `notification-${notificationId}-${channel}`],
    );
    return result.rows[0] ? String(result.rows[0].id) : null;
  }

  private async attemptDelivery(
    deliveryId: string,
    notificationId: number,
    userId: string,
    channel: NotificationChannel,
    recipient: string,
    message: string,
    type: NotificationType,
  ): Promise<void> {
    const claimed = await query(
      `UPDATE notification_deliveries
       SET status = 'sending', provider_message_id = NULL,
           attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status IN ('queued', 'retryable_failure')
         AND attempt_count < 5
       RETURNING attempt_count`,
      [deliveryId],
    );
    const attemptCount = Number(claimed.rows[0]?.attempt_count);
    if (!attemptCount) return;

    const outcome =
      channel === 'email'
        ? await sendEmail(recipient, message, type, notificationId, deliveryId)
        : await sendSMS(recipient, message);
    await this.persistProviderOutcome(deliveryId, channel, outcome, attemptCount);

    if (
      outcome.status === 'permanent_failure' &&
      channel === 'email' &&
      type === 'score_changed'
    ) {
      await this.queueConsentBasedSmsFailover(notificationId, userId);
    }
  }

  private async persistProviderOutcome(
    deliveryId: string,
    channel: NotificationChannel,
    outcome: ProviderOutcome,
    attemptCount: number,
  ): Promise<void> {
    const exhausted = outcome.status === 'retryable_failure' && attemptCount >= 5;
    const status = exhausted ? 'permanent_failure' : outcome.status;
    const nextAttemptAt =
      status === 'retryable_failure'
        ? new Date(Date.now() + getNotificationRetryDelayMs(attemptCount))
        : null;
    const errorCode = outcome.errorCode ?? (exhausted ? 'RETRY_EXHAUSTED' : null);
    await query(
      `INSERT INTO notification_delivery_attempts
         (delivery_id, attempt_number, provider, provider_message_id, status, error_code,
          accepted_at, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               CASE WHEN $5 = 'accepted' THEN CURRENT_TIMESTAMP ELSE NULL END,
               CASE WHEN $5 = 'delivered' THEN CURRENT_TIMESTAMP ELSE NULL END)
       ON CONFLICT (delivery_id, attempt_number) DO UPDATE
       SET provider_message_id = EXCLUDED.provider_message_id,
           status = EXCLUDED.status,
           error_code = EXCLUDED.error_code,
           accepted_at = EXCLUDED.accepted_at`,
      [
        deliveryId,
        attemptCount,
        outcome.provider,
        outcome.providerMessageId ?? null,
        status,
        errorCode,
      ],
    );
    await query(
      `UPDATE notification_deliveries
       SET provider = $1, provider_message_id = $2,
           status = $3, last_error_code = $4, next_attempt_at = $5,
           accepted_at = CASE WHEN $3 = 'accepted' THEN CURRENT_TIMESTAMP ELSE accepted_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [
        outcome.provider,
        outcome.providerMessageId ?? null,
        status,
        errorCode,
        nextAttemptAt,
        deliveryId,
      ],
    );
    if (status === 'retryable_failure' || status === 'permanent_failure') {
      notificationDeliveryFailuresCounter.inc({
        channel,
        provider: outcome.provider,
        failure_class: status === 'retryable_failure' ? 'retryable' : 'permanent',
      });
      logger.warn('Notification delivery failed', {
        deliveryId,
        channel,
        provider: outcome.provider,
        failureClass: status === 'retryable_failure' ? 'retryable' : 'permanent',
        errorCode: outcome.errorCode ?? (exhausted ? 'RETRY_EXHAUSTED' : 'UNKNOWN'),
        attemptCount,
      });
    }
  }

  private async queueConsentBasedSmsFailover(
    notificationId: number,
    userId: string,
  ): Promise<void> {
    const consent = await query(
      `SELECT sms_enabled, phone
       FROM user_profiles WHERE public_key = $1 LIMIT 1`,
      [userId],
    );
    const profile = consent.rows[0];
    if (!profile?.sms_enabled || typeof profile.phone !== 'string' || !profile.phone) return;

    await query(
      `INSERT INTO notification_deliveries
         (notification_id, channel, provider, idempotency_key, status)
       SELECT n.id, 'sms', 'twilio', $2, 'queued'
       FROM notifications n
       WHERE n.id = $1 AND n.type = 'score_changed'
       ON CONFLICT (notification_id, channel) DO NOTHING`,
      [notificationId, `notification-${notificationId}-sms-failover`],
    );
  }

  async processDeliveryRetries(): Promise<void> {
    const recovered = await query(
      `UPDATE notification_deliveries
       SET status = CASE WHEN attempt_count >= 5 THEN 'permanent_failure' ELSE 'retryable_failure' END,
           next_attempt_at = CASE WHEN attempt_count >= 5 THEN NULL ELSE CURRENT_TIMESTAMP END,
           last_error_code = 'ATTEMPT_RECOVERY',
           updated_at = CURRENT_TIMESTAMP
       FROM notifications n
       WHERE notification_deliveries.notification_id = n.id
         AND notification_deliveries.status = 'sending'
         AND notification_deliveries.updated_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
       RETURNING notification_deliveries.notification_id, notification_deliveries.channel,
                 notification_deliveries.attempt_count, n.user_id`,
    );
    for (const delivery of recovered.rows) {
      if (delivery.channel === 'email' && Number(delivery.attempt_count) >= 5) {
        await this.queueConsentBasedSmsFailover(
          Number(delivery.notification_id),
          String(delivery.user_id),
        );
      }
    }
    const claimed = await query(
      `WITH due AS (
         SELECT id
         FROM notification_deliveries
         WHERE status IN ('queued', 'retryable_failure')
           AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
           AND attempt_count < 5
         ORDER BY COALESCE(next_attempt_at, created_at), created_at
         LIMIT 50
         FOR UPDATE SKIP LOCKED
       )
       UPDATE notification_deliveries d
       SET status = 'sending', provider_message_id = NULL,
           attempt_count = d.attempt_count + 1,
           updated_at = CURRENT_TIMESTAMP
       FROM due
       WHERE d.id = due.id
       RETURNING d.id, d.notification_id, d.channel, d.provider, d.attempt_count`,
    );

    for (const delivery of claimed.rows) {
      try {
        const detail = await query(
          `SELECT n.user_id, n.type, n.message, p.email, p.phone, p.email_enabled, p.sms_enabled
           FROM notifications n
           JOIN user_profiles p ON p.public_key = n.user_id
           WHERE n.id = $1`,
          [delivery.notification_id],
        );
        const recipient = detail.rows[0];
        const channel = delivery.channel as NotificationChannel;
        const enabled =
          channel === 'email'
            ? recipient?.email_enabled && recipient.email
            : recipient?.sms_enabled && recipient.phone;
        if (!recipient || !enabled) {
          await this.persistProviderOutcome(
            String(delivery.id),
            channel,
            {
              status: 'permanent_failure',
              provider: channel === 'email' ? 'sendgrid' : 'twilio',
              errorCode: 'CONSENT_OR_RECIPIENT_UNAVAILABLE',
            },
            Number(delivery.attempt_count),
          );
          continue;
        }
        await this.deliverClaimed(
          delivery,
          recipient,
          channel,
          channel === 'email' ? String(recipient.email) : String(recipient.phone),
        );
      } catch (error) {
        logger.error('Notification retry attempt failed', {
          deliveryId: String(delivery.id),
          error,
        });
      }
    }
  }

  private async deliverClaimed(
    delivery: Record<string, unknown>,
    notification: Record<string, unknown>,
    channel: NotificationChannel,
    recipient: string,
  ): Promise<void> {
    const type = notification.type as NotificationType;
    const outcome =
      channel === 'email'
        ? await sendEmail(
            recipient,
            String(notification.message),
            type,
            Number(delivery.notification_id),
            String(delivery.id),
          )
        : await sendSMS(recipient, String(notification.message));
    await this.persistProviderOutcome(
      String(delivery.id),
      channel,
      outcome,
      Number(delivery.attempt_count),
    );
    if (
      outcome.status === 'permanent_failure' &&
      channel === 'email' &&
      type === 'score_changed'
    ) {
      await this.queueConsentBasedSmsFailover(
        Number(delivery.notification_id),
        String(notification.user_id),
      );
    }
  }

  async recordProviderReceipt(input: {
    provider: 'sendgrid' | 'twilio';
    providerMessageId: string;
    status: 'delivered' | 'retryable_failure' | 'permanent_failure';
    errorCode?: string;
  }): Promise<boolean> {
    return withTransaction(async (client) => {
      const selected = await client.query(
        `SELECT d.id, d.channel, d.status, a.id AS attempt_id, a.status AS attempt_status,
                a.created_at, n.created_at AS notification_created_at,
                d.attempt_count, d.provider_message_id AS current_provider_message_id
         FROM notification_delivery_attempts a
         JOIN notification_deliveries d ON d.id = a.delivery_id
         JOIN notifications n ON n.id = d.notification_id
         WHERE a.provider = $1 AND a.provider_message_id = $2
         FOR UPDATE`,
        [input.provider, input.providerMessageId],
      );
      const delivery = selected.rows[0] as Record<string, unknown> | undefined;
      if (!delivery) return false;
      if (
        delivery.attempt_status === 'delivered' ||
        delivery.attempt_status === 'permanent_failure'
      ) {
        return true;
      }
      if (delivery.attempt_status === input.status) return true;

      const effectiveStatus =
        input.status === 'retryable_failure' && Number(delivery.attempt_count) >= 5
          ? 'permanent_failure'
          : input.status;
      const errorCode =
        effectiveStatus === 'permanent_failure' && input.status === 'retryable_failure'
          ? 'RETRY_EXHAUSTED'
          : (input.errorCode ?? null);
      const nextAttemptAt =
        effectiveStatus === 'retryable_failure'
          ? new Date(
              Date.now() +
                getNotificationRetryDelayMs(Number(delivery.attempt_count)),
            )
          : null;
      await client.query(
        `UPDATE notification_delivery_attempts
         SET status = $1, error_code = $2,
             delivered_at = CASE WHEN $1 = 'delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END
         WHERE id = $3`,
        [effectiveStatus, errorCode, delivery.attempt_id],
      );
      const parentUpdate = await client.query(
        `UPDATE notification_deliveries
         SET status = $1, last_error_code = $2, next_attempt_at = $3,
             delivered_at = CASE WHEN $1 = 'delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4 AND status <> 'delivered'
           AND ($1 = 'delivered' OR provider_message_id = $5)`,
        [effectiveStatus, errorCode, nextAttemptAt, delivery.id, input.providerMessageId],
      );
      if (effectiveStatus === 'delivered') {
        if ((parentUpdate.rowCount ?? 0) > 0) {
          const lagSeconds =
            (Date.now() - new Date(String(delivery.notification_created_at)).getTime()) / 1000;
          notificationDeliveryLagHistogram.observe(
            { channel: String(delivery.channel), provider: input.provider },
            Math.max(0, lagSeconds),
          );
        }
      } else {
        notificationDeliveryFailuresCounter.inc({
          channel: String(delivery.channel),
          provider: input.provider,
          failure_class: effectiveStatus === 'retryable_failure' ? 'retryable' : 'permanent',
        });
        if (
          effectiveStatus === 'permanent_failure' &&
          delivery.current_provider_message_id === input.providerMessageId
        ) {
          await client.query(
            `INSERT INTO notification_deliveries
               (notification_id, channel, provider, idempotency_key, status)
             SELECT n.id, 'sms', 'twilio',
                    'notification-' || n.id::text || '-sms-failover', 'queued'
             FROM notification_deliveries d
             JOIN notifications n ON n.id = d.notification_id
             JOIN user_profiles p ON p.public_key = n.user_id
             WHERE d.id = $1 AND d.channel = 'email' AND d.provider_message_id = $2
               AND n.type = 'score_changed' AND p.sms_enabled = true
               AND p.phone IS NOT NULL AND p.phone <> ''
             ON CONFLICT (notification_id, channel) DO NOTHING`,
            [delivery.id, input.providerMessageId],
          );
        }
      }
      return true;
    });
  }

  /**
   * Returns the most recent notifications for a user (newest first).
   * Supports filtering by type, status, and date range.
   */
  async getNotificationsForUser(
    userId: string,
    limit = 50,
    type?: string,
    status?: string,
    from?: string,
    to?: string,
  ): Promise<Notification[]> {
    let whereClause = 'user_id = $1';
    const params: (string | number)[] = [userId];
    let paramIndex = 2;

    if (type) {
      whereClause += ` AND type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (status) {
      whereClause += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (from) {
      const fromDate = new Date(from);
      if (Number.isNaN(fromDate.getTime())) {
        throw new Error("Invalid 'from' date format");
      }
      whereClause += ` AND created_at >= $${paramIndex}`;
      params.push(fromDate.toISOString());
      paramIndex++;
    }

    if (to) {
      const toDate = new Date(to);
      if (Number.isNaN(toDate.getTime())) {
        throw new Error("Invalid 'to' date format");
      }
      whereClause += ` AND created_at <= $${paramIndex}`;
      params.push(toDate.toISOString());
      paramIndex++;
    }

    const result = await query(
      `SELECT id, user_id, type, title, message, loan_id, action_url, read, status, created_at
         FROM notifications
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${paramIndex}`,
      [...params, limit],
    );
    return result.rows.map(this.mapRow);
  }

  /**
   * Returns the unread notification count for a user.
   */
  async getUnreadCount(userId: string): Promise<number> {
    const result = await query(
      `SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND status = 'unread'`,
      [userId],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Marks specific notifications as read.
   * Only updates rows that belong to the given user to prevent cross-user access.
   */
  async markRead(userId: string, ids: number[]): Promise<void> {
    if (!ids.length) return;
    await query(
      `UPDATE notifications SET read = true, status = 'read'
       WHERE user_id = $1 AND id = ANY($2::int[]) AND status = 'unread'`,
      [userId, ids],
    );
  }

  /**
   * Marks all notifications for a user as read.
   */
  async markAllRead(userId: string): Promise<void> {
    await query(
      `UPDATE notifications SET read = true, status = 'read'
       WHERE user_id = $1 AND status = 'unread'`,
      [userId],
    );
  }

  /**
   * Archives specific notifications for a user.
   * Archived notifications are excluded from the main feed and cleaned up sooner.
   */
  async archiveNotifications(userId: string, ids: number[]): Promise<void> {
    if (!ids.length) return;
    await query(
      `UPDATE notifications SET read = true, status = 'archived'
       WHERE user_id = $1 AND id = ANY($2::int[]) AND status != 'archived'`,
      [userId, ids],
    );
  }

  /**
   * Notifies all admins of a dispute via:
   * 1. Email to ADMIN_EMAIL (if configured)
   * 2. In-app SSE push to each admin wallet currently subscribed
   * 3. Webhook POST to ADMIN_WEBHOOK_URL (if configured)
   */
  async notifyAdmins(params: { title: string; message: string; loanId?: number }): Promise<void> {
    const { title, message, loanId } = params;

    // 1. Email the configured admin address
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      await sendEmail(adminEmail, message);
    } else {
      logger.withContext().warn('[Admin] ADMIN_EMAIL not set — logging dispute only', {
        title,
        message,
      });
    }

    // 2. Push SSE notification to every admin currently connected
    try {
      const adminWallets = (process.env.ADMIN_WALLETS ?? '')
        .split(',')
        .map((w) => w.trim())
        .filter((w) => w.length > 0);

      for (const adminId of adminWallets) {
        const actionUrl = loanId != null ? `/loans/${loanId}` : null;
        const result = await query(
          `INSERT INTO notifications (user_id, type, title, message, loan_id, action_url, status)
           VALUES ($1, 'loan_defaulted', $2, $3, $4, $5, 'unread')
           RETURNING id, user_id, type, title, message, loan_id, action_url, read, status, created_at`,
          [adminId, title, message, loanId ?? null, actionUrl],
        );
        const notification = this.mapRow(result.rows[0]);
        this.broadcast(adminId, notification);
      }
    } catch (err) {
      logger.withContext().error('[Admin] Failed to persist/push admin notifications', {
        err,
      });
    }

    // 3. Optional webhook (Slack / Discord / custom)
    const webhookUrl = process.env.ADMIN_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `[RemitLend] ${title}: ${message}` }),
        });
      } catch (err) {
        logger.withContext().error('[Admin] Webhook POST failed', { webhookUrl, err });
      }
    }
  }

  // ─── SSE helpers ────────────────────────────────────────────────────────────

  /**
   * Registers an SSE response stream for the given user.
   * Returns an unsubscribe function that should be called when the client
   * disconnects.
   */
  subscribe(userId: string, res: SseClient): () => void {
    if (!sseClients.has(userId)) {
      sseClients.set(userId, new Set());
    }
    sseClients.get(userId)!.add(res);

    return () => {
      sseClients.get(userId)?.delete(res);
      if (sseClients.get(userId)?.size === 0) {
        sseClients.delete(userId);
      }
    };
  }

  /**
   * Pushes a notification to all active SSE streams for the given user.
   */
  private broadcast(userId: string, notification: Notification): void {
    const clients = sseClients.get(userId);
    if (!clients?.size) return;

    const data = `data: ${JSON.stringify(notification)}\n\n`;
    for (const res of clients) {
      try {
        res.write(data);
      } catch (err) {
        logger.withContext().error('SSE write error', { userId, err });
        clients.delete(res);
      }
    }
  }

  /**
   * Deletes notifications older than the specified number of days.
   * @param retentionDays The number of days to keep notifications.
   * @returns The number of deleted notifications.
   */
  async deleteOldNotifications(retentionDays: number): Promise<number> {
    try {
      const result = await query(
        `DELETE FROM notifications
         WHERE created_at < NOW() - (INTERVAL '1 day' * $1)`,
        [retentionDays],
      );
      const deletedCount = result.rowCount ?? 0;
      if (deletedCount > 0) {
        logger.withContext().info(`Notification cleanup completed: ${deletedCount} rows deleted`, {
          retentionDays,
        });
      }
      return deletedCount;
    } catch (error) {
      logger.withContext().error('Error during notification cleanup', {
        error,
        retentionDays,
      });
      return 0;
    }
  }

  /**
   * Deletes read and archived notifications older than the specified number of days.
   * Acknowledged notifications are cleaned up on a shorter retention cycle than unread ones.
   * @param retentionDays The number of days to keep read/archived notifications.
   * @returns The number of deleted notifications.
   */
  async deleteReadAndArchived(retentionDays: number): Promise<number> {
    try {
      const result = await query(
        `DELETE FROM notifications
         WHERE status IN ('read', 'archived')
           AND created_at < NOW() - (INTERVAL '1 day' * $1)`,
        [retentionDays],
      );
      const deletedCount = result.rowCount ?? 0;
      if (deletedCount > 0) {
        logger
          .withContext()
          .info(`Read/archived notification cleanup completed: ${deletedCount} rows deleted`, {
            retentionDays,
          });
      }
      return deletedCount;
    } catch (error) {
      logger.withContext().error('Error during read/archived notification cleanup', {
        error,
        retentionDays,
      });
      return 0;
    }
  }

  // ─── Row mapper ──────────────────────────────────────────────────────────────

  private mapRow(row: Record<string, unknown>): Notification {
    const loanId = row.loan_id != null ? (row.loan_id as number) : undefined;
    const actionUrl = row.action_url != null ? (row.action_url as string) : undefined;
    const base = {
      id: row.id as number,
      userId: row.user_id as string,
      type: row.type as NotificationType,
      title: row.title as string,
      message: row.message as string,
      read: row.read as boolean,
      status: (row.status as NotificationStatus) ?? (row.read ? 'read' : 'unread'),
      createdAt: new Date(row.created_at as string),
    };
    // Keep optional fields omitted rather than null so the mapped shape is
    // consistent (loanId is treated the same way).
    const withLoan = loanId !== undefined ? { ...base, loanId } : base;
    return actionUrl !== undefined ? { ...withLoan, actionUrl } : withLoan;
  }
}

export const notificationService = new NotificationService();

let cleanupInterval: ReturnType<typeof setInterval> | undefined;
let deliveryRetryInterval: ReturnType<typeof setInterval> | undefined;

export function startNotificationDeliveryProcessor(): void {
  if (deliveryRetryInterval) return;
  const run = () => {
    notificationService.processDeliveryRetries().catch((error) => {
      logger.error('Notification delivery processor failed', { error });
    });
  };
  run();
  deliveryRetryInterval = setInterval(run, 10_000);
  deliveryRetryInterval.unref?.();
}

export function stopNotificationDeliveryProcessor(): void {
  if (!deliveryRetryInterval) return;
  clearInterval(deliveryRetryInterval);
  deliveryRetryInterval = undefined;
}

/**
 * Starts a periodic scheduler to clean up old notifications based on retention policy.
 */
export function startNotificationCleanupScheduler(): void {
  if (cleanupInterval) return;

  const retentionDays = parseInt(process.env.NOTIFICATION_RETENTION_DAYS || '90', 10);
  const readRetentionDays = parseInt(process.env.READ_NOTIFICATION_RETENTION_DAYS || '30', 10);
  const intervalMs = parseInt(
    process.env.NOTIFICATION_CLEANUP_INTERVAL_MS || String(24 * 60 * 60 * 1000), // Default: 24h
    10,
  );

  // Run once immediately on start to clear any backlog
  void notificationService.deleteOldNotifications(retentionDays);
  void notificationService.deleteReadAndArchived(readRetentionDays);

  cleanupInterval = setInterval(async () => {
    await notificationService.deleteOldNotifications(retentionDays);
    await notificationService.deleteReadAndArchived(readRetentionDays);
  }, intervalMs);

  logger.withContext().info('Notification cleanup scheduler started', {
    retentionDays,
    readRetentionDays,
    intervalMs,
  });
}

/**
 * Stops the notification cleanup scheduler.
 */
export function stopNotificationCleanupScheduler(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = undefined;
    logger.withContext().info('Notification cleanup scheduler stopped');
  }
}
