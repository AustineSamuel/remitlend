import crypto from 'node:crypto';
import { query, withTransaction } from '../db/connection.js';
import {
  retentionJobRunsCounter,
  retentionRowsProcessedCounter,
} from '../middleware/metrics.js';
import { cacheService } from './cacheService.js';
import { CacheKeys } from '../utils/cacheKeys.js';
import { expireSubjectAccessExports } from './subjectAccessExportService.js';
import logger from '../utils/logger.js';

const BATCH_SIZE = 100;
const SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;

export const RETENTION_POLICIES = [
  { dataClass: 'notifications', days: 90, operation: 'delete' },
  { dataClass: 'subject_access_exports', days: 1, operation: 'expire_archive' },
  { dataClass: 'scores', years: 5, operation: 'delete_after_loan_closure' },
  { dataClass: 'remittances', years: 5, operation: 'anonymize' },
  { dataClass: 'remittance_history', years: 5, operation: 'delete' },
  { dataClass: 'loan_events', years: 7, operation: 'soft_delete_then_delete' },
  { dataClass: 'audit_logs', years: 7, operation: 'delete' },
  { dataClass: 'loan_disputes', years: 7, operation: 'delete' },
  { dataClass: 'webhook_deliveries', days: 90, operation: 'delete' },
  { dataClass: 'webhook_subscriptions', days: 30, operation: 'delete_after_cancellation' },
  { dataClass: 'quarantine_events', days: 90, operation: 'delete' },
  { dataClass: 'transaction_submissions', years: 2, operation: 'delete' },
  { dataClass: 'ledger_checkpoints', days: 30, operation: 'delete_except_latest' },
] as const;

export type RetentionDataClass = (typeof RETENTION_POLICIES)[number]['dataClass'];

export function isRetentionDataClass(value: string): value is RetentionDataClass {
  return RETENTION_POLICIES.some((policy) => policy.dataClass === value);
}

export class RetentionRecordNotFoundError extends Error {
  constructor() {
    super('Retention record not found');
    this.name = 'RetentionRecordNotFoundError';
  }
}

export class ActiveRetentionLegalHoldError extends Error {
  constructor() {
    super('An active legal hold already covers this record');
    this.name = 'ActiveRetentionLegalHoldError';
  }
}

interface RetentionRunCounts {
  [operation: string]: number;
}

interface RetentionRunResult {
  id: string;
  status: 'completed' | 'partial' | 'failed' | 'skipped';
}

function cutoffForPolicy(policy: (typeof RETENTION_POLICIES)[number], now = new Date()): Date {
  if ('days' in policy) {
    return new Date(now.getTime() - policy.days * 24 * 60 * 60 * 1000);
  }
  const cutoff = new Date(now);
  const dayOfMonth = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - policy.years);
  const lastDayOfCutoffMonth = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(dayOfMonth, lastDayOfCutoffMonth));
  return cutoff;
}

function countRows(result: { rowCount?: number | null; rows: unknown[] }): number {
  const firstRow = result.rows[0] as { affected_count?: number } | undefined;
  return Number(firstRow?.affected_count ?? result.rowCount ?? result.rows.length);
}

async function claimLease(token: string): Promise<boolean> {
  const result = await query(
    `UPDATE retention_job_lease
     SET token = $1, lease_until = CURRENT_TIMESTAMP + ($2 * INTERVAL '1 millisecond')
     WHERE id = 1 AND (lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP)
     RETURNING id`,
    [token, LEASE_MS],
  );
  return result.rows.length > 0;
}

async function releaseLease(token: string): Promise<void> {
  await query(
    `UPDATE retention_job_lease
     SET token = NULL, lease_until = NULL
     WHERE id = 1 AND token = $1`,
    [token],
  );
}

async function deleteExpiredNotifications(cutoff: Date): Promise<number> {
  const result = await query(
    `WITH expired AS (
       SELECT n.id
       FROM notifications n
       WHERE COALESCE(
           (SELECT MAX(d.delivered_at)
            FROM notification_deliveries d
            WHERE d.notification_id = n.id),
           n.created_at
         ) < $1
         AND NOT EXISTS (
           SELECT 1 FROM notification_deliveries pending
           WHERE pending.notification_id = n.id
             AND pending.status IN ('queued', 'sending', 'retryable_failure')
         )
         AND NOT EXISTS (
           SELECT 1 FROM retention_legal_holds h
           WHERE h.data_class = 'notifications' AND h.record_id = n.id::text
             AND h.released_at IS NULL
         )
       ORDER BY n.created_at, n.id
       LIMIT $2
       FOR UPDATE OF n SKIP LOCKED
     )
     DELETE FROM notifications n USING expired e
     WHERE n.id = e.id`,
    [cutoff, BATCH_SIZE],
  );
  return countRows(result);
}

async function anonymizeOldRemittances(cutoff: Date): Promise<number> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `WITH candidates AS (
         SELECT r.id
         FROM remittances r
         WHERE r.created_at < $1 AND r.status IN ('completed', 'failed')
           AND r.retention_anonymized_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM retention_legal_holds h
             WHERE h.data_class = 'remittances' AND h.record_id = r.id::text
               AND h.released_at IS NULL
           )
         ORDER BY r.created_at, r.id
         LIMIT $2
         FOR UPDATE OF r SKIP LOCKED
       ), anonymized AS (
         UPDATE remittances r
         SET recipient_address = NULL, memo = NULL, xdr = NULL, error_message = NULL,
             retention_anonymized_at = CURRENT_TIMESTAMP
         FROM candidates c
         WHERE r.id = c.id
         RETURNING r.sender_id
       ), queued AS (
         INSERT INTO retention_cache_invalidations (cache_kind, subject_key)
         SELECT DISTINCT 'borrower_loans', sender_id FROM anonymized
         WHERE sender_id IS NOT NULL
         RETURNING id
       )
       SELECT (SELECT COUNT(*) FROM anonymized)::integer AS affected_count`,
      [cutoff, BATCH_SIZE],
    );
    return Number((result.rows[0] as { affected_count?: number } | undefined)?.affected_count ?? 0);
  });
}

async function processDataClass(
  dataClass: RetentionDataClass,
  cutoff: Date,
): Promise<RetentionRunCounts> {
  switch (dataClass) {
    case 'notifications':
      return { delete: await deleteExpiredNotifications(cutoff) };
    case 'subject_access_exports':
      return { expire_archive: await expireSubjectAccessExports(BATCH_SIZE) };
    case 'remittances':
      return { anonymize: await anonymizeOldRemittances(cutoff) };
    case 'scores': {
      const result = await withTransaction(async (client) =>
        client.query(
          `WITH expired AS (
           SELECT s.id FROM scores s
           WHERE EXISTS (
             SELECT 1 FROM loan_history l WHERE l.borrower_public_key = s.borrower
           )
             AND NOT EXISTS (
               SELECT 1 FROM loan_history active
               WHERE active.borrower_public_key = s.borrower
                 AND LOWER(active.status) NOT IN ('repaid', 'defaulted', 'liquidated', 'closed')
             )
             AND (
               SELECT MAX(COALESCE(l.repaid_at, l.defaulted_at, l.updated_at))
               FROM loan_history l WHERE l.borrower_public_key = s.borrower
             ) < $1
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'scores' AND h.record_id = s.id::text
                 AND h.released_at IS NULL
             )
             ORDER BY s.id LIMIT $2 FOR UPDATE OF s SKIP LOCKED
         ), deleted AS (
           DELETE FROM scores s USING expired e WHERE s.id = e.id
           RETURNING s.borrower
         ), queued AS (
           INSERT INTO retention_cache_invalidations (cache_kind, subject_key)
           SELECT keys.cache_kind, deleted.borrower
           FROM deleted
           CROSS JOIN (VALUES
             ('score_response'),
             ('score_breakdown'),
             ('legacy_score_response'),
             ('legacy_score_breakdown')
           ) AS keys(cache_kind)
           RETURNING id
         )
         SELECT COUNT(*)::integer AS affected_count FROM deleted`,
          [cutoff, BATCH_SIZE],
        ),
      );
      return { delete_after_loan_closure: countRows(result) };
    }
    case 'remittance_history': {
      const result = await query(
        `WITH expired AS (
           SELECT r.id FROM remittance_history r
           WHERE r.created_at < $1
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'remittance_history' AND h.record_id = r.id::text
                 AND h.released_at IS NULL
             )
           ORDER BY r.created_at, r.id LIMIT $2 FOR UPDATE OF r SKIP LOCKED
         )
         DELETE FROM remittance_history r USING expired e WHERE r.id = e.id`,
        [cutoff, BATCH_SIZE],
      );
      return { delete: countRows(result) };
    }
    case 'loan_events': {
      const softDeleted = await query(
        `WITH candidates AS (
           SELECT e.id FROM contract_events e
           WHERE e.created_at < $1 AND e.retention_deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'loan_events' AND h.record_id = e.id::text
                 AND h.released_at IS NULL
             )
             AND (
               e.loan_id IS NULL OR EXISTS (
                 SELECT 1 FROM loan_history l
                 WHERE l.loan_id = e.loan_id
                   AND LOWER(l.status) IN ('repaid', 'defaulted', 'liquidated', 'closed')
                   AND COALESCE(l.repaid_at, l.defaulted_at, l.updated_at) < $1
               )
             )
           ORDER BY e.created_at, e.id LIMIT $2 FOR UPDATE OF e SKIP LOCKED
         )
         UPDATE contract_events e SET retention_deleted_at = CURRENT_TIMESTAMP
         FROM candidates c WHERE e.id = c.id`,
        [cutoff, BATCH_SIZE],
      );
      const hardDelete = await query(
        `WITH expired AS (
           SELECT e.id FROM contract_events e
           WHERE e.retention_deleted_at < CURRENT_TIMESTAMP - INTERVAL '90 days'
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'loan_events' AND h.record_id = e.id::text
                 AND h.released_at IS NULL
             )
               AND (
                 e.loan_id IS NULL OR EXISTS (
                   SELECT 1 FROM loan_history l
                   WHERE l.loan_id = e.loan_id
                     AND LOWER(l.status) IN ('repaid', 'defaulted', 'liquidated', 'closed')
                     AND COALESCE(l.repaid_at, l.defaulted_at, l.updated_at) < $2
                 )
               )
             ORDER BY e.retention_deleted_at, e.id LIMIT $1 FOR UPDATE OF e SKIP LOCKED
           )
           DELETE FROM contract_events e USING expired x WHERE e.id = x.id`,
        [Math.max(0, BATCH_SIZE - countRows(softDeleted)), cutoff],
      );
      return { soft_delete: countRows(softDeleted), hard_delete: countRows(hardDelete) };
    }
    case 'audit_logs': {
      const result = await query(
        `WITH expired AS (
           SELECT a.id FROM audit_logs a
           WHERE a.created_at < $1
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'audit_logs' AND h.record_id = a.id::text
                 AND h.released_at IS NULL
             )
           ORDER BY a.created_at, a.id LIMIT $2 FOR UPDATE OF a SKIP LOCKED
         )
         DELETE FROM audit_logs a USING expired e WHERE a.id = e.id`,
        [cutoff, BATCH_SIZE],
      );
      return { delete: countRows(result) };
    }
    case 'loan_disputes': {
      const result = await query(
        `WITH expired AS (
           SELECT d.id FROM loan_disputes d
           WHERE d.resolved_at IS NOT NULL AND d.resolved_at < $1
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'loan_disputes' AND h.record_id = d.id::text
                 AND h.released_at IS NULL
             )
           ORDER BY d.resolved_at, d.id LIMIT $2 FOR UPDATE OF d SKIP LOCKED
         )
         DELETE FROM loan_disputes d USING expired e WHERE d.id = e.id`,
        [cutoff, BATCH_SIZE],
      );
      return { delete: countRows(result) };
    }
    case 'webhook_deliveries': {
      const result = await query(
        `WITH expired AS (
           SELECT d.id FROM webhook_deliveries d
           WHERE d.created_at < $1
             AND (d.delivered_at IS NOT NULL OR d.next_retry_at IS NULL
                  OR d.next_retry_at < CURRENT_TIMESTAMP)
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'webhook_deliveries' AND h.record_id = d.id::text
                 AND h.released_at IS NULL
             )
           ORDER BY d.created_at, d.id LIMIT $2 FOR UPDATE OF d SKIP LOCKED
         )
         DELETE FROM webhook_deliveries d USING expired e WHERE d.id = e.id`,
        [cutoff, BATCH_SIZE],
      );
      return { delete: countRows(result) };
    }
    case 'webhook_subscriptions': {
      const result = await query(
        `WITH expired AS (
           SELECT s.id FROM webhook_subscriptions s
           WHERE s.canceled_at IS NOT NULL AND s.canceled_at < $1
             AND NOT EXISTS (
               SELECT 1 FROM webhook_deliveries d WHERE d.subscription_id = s.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'webhook_subscriptions' AND h.record_id = s.id::text
                 AND h.released_at IS NULL
             )
           ORDER BY s.canceled_at, s.id LIMIT $2 FOR UPDATE OF s SKIP LOCKED
         )
         DELETE FROM webhook_subscriptions s USING expired e WHERE s.id = e.id`,
        [cutoff, BATCH_SIZE],
      );
      return { delete_after_cancellation: countRows(result) };
    }
    case 'quarantine_events': {
      const result = await query(
        `WITH expired AS (
           SELECT q.id FROM quarantine_events q
           WHERE q.quarantined_at < $1
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'quarantine_events' AND h.record_id = q.id::text
                 AND h.released_at IS NULL
             )
           ORDER BY q.quarantined_at, q.id LIMIT $2 FOR UPDATE OF q SKIP LOCKED
         )
         DELETE FROM quarantine_events q USING expired e WHERE q.id = e.id`,
        [cutoff, BATCH_SIZE],
      );
      return { delete: countRows(result) };
    }
    case 'transaction_submissions': {
      const result = await query(
        `WITH expired AS (
           SELECT t.id FROM transaction_submissions t
           WHERE t.submitted_at < $1
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'transaction_submissions' AND h.record_id = t.id::text
                 AND h.released_at IS NULL
             )
           ORDER BY t.submitted_at, t.id LIMIT $2 FOR UPDATE OF t SKIP LOCKED
         )
         DELETE FROM transaction_submissions t USING expired e WHERE t.id = e.id`,
        [cutoff, BATCH_SIZE],
      );
      return { delete: countRows(result) };
    }
    case 'ledger_checkpoints': {
      const result = await query(
        `WITH expired AS (
           SELECT c.id FROM ledger_checkpoints c
           WHERE c.created_at < $1
             AND EXISTS (
               SELECT 1 FROM ledger_checkpoints newer
               WHERE newer.contract = c.contract AND newer.range_end > c.range_end
             )
             AND NOT EXISTS (
               SELECT 1 FROM retention_legal_holds h
               WHERE h.data_class = 'ledger_checkpoints' AND h.record_id = c.id::text
                 AND h.released_at IS NULL
             )
           ORDER BY c.created_at, c.id LIMIT $2 FOR UPDATE OF c SKIP LOCKED
         )
         DELETE FROM ledger_checkpoints c USING expired e WHERE c.id = e.id`,
        [cutoff, BATCH_SIZE],
      );
      return { delete_except_latest: countRows(result) };
    }
  }
}

async function processCacheInvalidations(): Promise<number> {
  const claimed = await withTransaction(async (client) => {
    const result = await client.query(
      `WITH due AS (
         SELECT id FROM retention_cache_invalidations
         WHERE next_attempt_at <= CURRENT_TIMESTAMP
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE retention_cache_invalidations i
       SET attempts = attempts + 1,
           next_attempt_at = CURRENT_TIMESTAMP + INTERVAL '1 minute'
       FROM due WHERE i.id = due.id
       RETURNING i.id, i.cache_kind, i.subject_key`,
      [BATCH_SIZE],
    );
    return result.rows as Array<{ id: number; cache_kind: string; subject_key: string }>;
  });

  let invalidated = 0;
  for (const row of claimed) {
    const key =
      row.cache_kind === 'borrower_loans'
        ? CacheKeys.borrowerLoans(row.subject_key)
        : row.cache_kind === 'score_response'
          ? CacheKeys.scoreResponse(row.subject_key)
          : row.cache_kind === 'score_breakdown'
            ? CacheKeys.scoreBreakdown(row.subject_key)
            : row.cache_kind === 'legacy_score_response'
              ? CacheKeys.legacyScoreResponse(row.subject_key)
              : row.cache_kind === 'legacy_score_breakdown'
                ? CacheKeys.legacyScoreBreakdown(row.subject_key)
                : null;
    if (!key) {
      logger.error('Unknown retention cache invalidation kind', { cacheKind: row.cache_kind });
      continue;
    }
    if (await cacheService.deleteForRetention(key)) {
      await query('DELETE FROM retention_cache_invalidations WHERE id = $1', [row.id]);
      invalidated += 1;
    } else {
      logger.warn('Retention cache invalidation will be retried', { cacheKind: row.cache_kind });
    }
  }
  return invalidated;
}

async function persistClassResult(
  runId: string,
  dataClass: string,
  cutoff: Date,
  counts: RetentionRunCounts,
  status: 'completed' | 'partial' | 'failed',
  errorCode?: string,
): Promise<void> {
  const affectedCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO retention_job_run_classes
         (run_id, data_class, cutoff_at, operation_counts, affected_count, status, error_code)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (run_id, data_class) DO UPDATE
       SET operation_counts = EXCLUDED.operation_counts,
           affected_count = EXCLUDED.affected_count,
           status = EXCLUDED.status,
           error_code = EXCLUDED.error_code,
           cutoff_at = EXCLUDED.cutoff_at,
           completed_at = CURRENT_TIMESTAMP`,
      [runId, dataClass, cutoff, JSON.stringify(counts), affectedCount, status, errorCode ?? null],
    );
    await client.query(
      `INSERT INTO retention_job_state
         (data_class, last_run_id, last_started_at, last_completed_at,
          last_processed_count, last_error_code)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CASE WHEN $3 = 'failed' THEN NULL ELSE CURRENT_TIMESTAMP END,
               $4, $5)
       ON CONFLICT (data_class) DO UPDATE
       SET last_run_id = EXCLUDED.last_run_id,
           last_started_at = EXCLUDED.last_started_at,
           last_completed_at = CASE
             WHEN $3 = 'failed' THEN retention_job_state.last_completed_at
             ELSE CURRENT_TIMESTAMP END,
           last_processed_count = EXCLUDED.last_processed_count,
           last_error_code = EXCLUDED.last_error_code`,
      [dataClass, runId, status, affectedCount, errorCode ?? null],
    );
  });
  for (const [operation, count] of Object.entries(counts)) {
    if (count > 0) retentionRowsProcessedCounter.inc({ data_class: dataClass, operation }, count);
  }
}

export async function runDataRetentionJob(now = new Date()): Promise<RetentionRunResult> {
  const leaseToken = crypto.randomUUID();
  if (!(await claimLease(leaseToken))) return { id: '', status: 'skipped' };
  const runId = crypto.randomUUID();
  let failedClasses = 0;
  let partialClasses = 0;
  try {
    await query(`INSERT INTO retention_job_runs (id) VALUES ($1)`, [runId]);
    await query(
      `UPDATE retention_job_runs
       SET status = 'failed', completed_at = CURRENT_TIMESTAMP
       WHERE status = 'running' AND started_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'`,
    );
    for (const policy of RETENTION_POLICIES) {
      const cutoff = cutoffForPolicy(policy, now);
      let counts: RetentionRunCounts = {};
      let status: 'completed' | 'partial' | 'failed' = 'completed';
      let errorCode: string | undefined;
      try {
        counts = await processDataClass(policy.dataClass, cutoff);
      } catch (error) {
        status = 'failed';
        errorCode = 'PROCESSING_FAILED';
        failedClasses += 1;
        logger.error('Retention data class failed', { dataClass: policy.dataClass, error });
      }
      if (policy.dataClass === 'remittances' || policy.dataClass === 'scores') {
        try {
          const invalidated = await processCacheInvalidations();
          counts.cache_invalidation = invalidated;
          const pending = await query(
            `SELECT COUNT(*)::integer AS count FROM retention_cache_invalidations`,
          );
          if (Number((pending.rows[0] as { count?: number } | undefined)?.count ?? 0) > 0) {
            status = 'partial';
            partialClasses += 1;
          }
        } catch (error) {
          status = 'partial';
          partialClasses += 1;
          errorCode = 'CACHE_INVALIDATION_PENDING';
          logger.error('Retention cache invalidation processing failed', { error });
        }
      }
      await persistClassResult(runId, policy.dataClass, cutoff, counts, status, errorCode);
      logger.info('retention_purge', {
        event: 'retention_purge',
        dataClass: policy.dataClass,
        cutoffAt: cutoff.toISOString(),
        operationCounts: counts,
        status,
        ...(errorCode ? { errorCode } : {}),
      });
    }
    const status =
      failedClasses === RETENTION_POLICIES.length
        ? 'failed'
        : failedClasses > 0 || partialClasses > 0
          ? 'partial'
          : 'completed';
    await query(
      `UPDATE retention_job_runs
       SET status = $2, completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [runId, status],
    );
    retentionJobRunsCounter.inc({ outcome: status });
    return { id: runId, status };
  } catch (error) {
    await query(
      `UPDATE retention_job_runs
       SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [runId],
    );
    retentionJobRunsCounter.inc({ outcome: 'failed' });
    logger.error('Retention job failed', { runId, error });
    return { id: runId, status: 'failed' };
  } finally {
    await releaseLease(leaseToken);
  }
}

export async function createRetentionLegalHold(input: {
  dataClass: RetentionDataClass;
  recordId: string;
  basis: string;
  actor: string;
}): Promise<string> {
  if (!input.basis.trim() || input.basis.trim().length < 20 || input.basis.length > 2000) {
    throw new Error('A legal-hold basis between 20 and 2000 characters is required');
  }
  const targetTables: Record<RetentionDataClass, string> = {
    notifications: 'notifications',
    subject_access_exports: 'subject_access_exports',
    scores: 'scores',
    remittances: 'remittances',
    remittance_history: 'remittance_history',
    loan_events: 'contract_events',
    audit_logs: 'audit_logs',
    loan_disputes: 'loan_disputes',
    webhook_deliveries: 'webhook_deliveries',
    webhook_subscriptions: 'webhook_subscriptions',
    quarantine_events: 'quarantine_events',
    transaction_submissions: 'transaction_submissions',
    ledger_checkpoints: 'ledger_checkpoints',
  };
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT id FROM ${targetTables[input.dataClass]} WHERE id::text = $1 LIMIT 1`,
      [input.recordId],
    );
    if (existing.rows.length === 0) throw new RetentionRecordNotFoundError();
    const inserted = await client.query(
      `INSERT INTO retention_legal_holds
         (data_class, record_id, basis, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (data_class, record_id) WHERE released_at IS NULL DO NOTHING
       RETURNING id`,
      [input.dataClass, input.recordId, input.basis.trim(), input.actor],
    );
    if (inserted.rows.length === 0) throw new ActiveRetentionLegalHoldError();
    const holdId = String((inserted.rows[0] as { id: string }).id);
    await client.query(
      `INSERT INTO retention_legal_hold_audit (hold_id, action, actor, basis)
       VALUES ($1, 'created', $2, $3)`,
      [holdId, input.actor, input.basis.trim()],
    );
    return holdId;
  });
}

export async function releaseRetentionLegalHold(input: {
  holdId: string;
  basis: string;
  actor: string;
}): Promise<boolean> {
  if (!input.basis.trim() || input.basis.trim().length < 20 || input.basis.length > 2000) {
    throw new Error('A release basis between 20 and 2000 characters is required');
  }
  return withTransaction(async (client) => {
    const released = await client.query(
      `UPDATE retention_legal_holds
       SET released_by = $2, released_at = CURRENT_TIMESTAMP, release_basis = $3
       WHERE id = $1 AND released_at IS NULL
       RETURNING id`,
      [input.holdId, input.actor, input.basis.trim()],
    );
    if (released.rows.length === 0) return false;
    await client.query(
      `INSERT INTO retention_legal_hold_audit (hold_id, action, actor, basis)
       VALUES ($1, 'released', $2, $3)`,
      [input.holdId, input.actor, input.basis.trim()],
    );
    return true;
  });
}

export async function listRetentionLegalHolds(): Promise<
  Array<{ id: string; dataClass: string; recordId: string; basis: string; createdAt: string }>
> {
  const result = await query(
    `SELECT id, data_class, record_id, basis, created_at
     FROM retention_legal_holds WHERE released_at IS NULL
     ORDER BY created_at DESC LIMIT 100`,
  );
  return result.rows.map((row) => {
    const hold = row as Record<string, unknown>;
    return {
      id: String(hold.id),
      dataClass: String(hold.data_class),
      recordId: String(hold.record_id),
      basis: String(hold.basis),
      createdAt: new Date(String(hold.created_at)).toISOString(),
    };
  });
}

export async function getRecentRetentionRuns(): Promise<
  Array<{ id: string; status: string; startedAt: string; completedAt: string | null; classes: unknown[] }>
> {
  const result = await query(
    `SELECT r.id, r.status, r.started_at, r.completed_at,
            COALESCE(jsonb_agg(jsonb_build_object(
              'dataClass', c.data_class,
              'cutoffAt', c.cutoff_at,
              'affectedCount', c.affected_count,
              'operationCounts', c.operation_counts,
              'status', c.status,
              'errorCode', c.error_code
            ) ORDER BY c.data_class) FILTER (WHERE c.data_class IS NOT NULL), '[]'::jsonb) AS classes
     FROM retention_job_runs r
     LEFT JOIN retention_job_run_classes c ON c.run_id = r.id
     GROUP BY r.id
     ORDER BY r.started_at DESC LIMIT 20`,
  );
  return result.rows.map((row) => {
    const run = row as Record<string, unknown>;
    return {
      id: String(run.id),
      status: String(run.status),
      startedAt: new Date(String(run.started_at)).toISOString(),
      completedAt: run.completed_at ? new Date(String(run.completed_at)).toISOString() : null,
      classes: (run.classes ?? []) as unknown[],
    };
  });
}

let scheduler: NodeJS.Timeout | undefined;

export function startDataRetentionScheduler(): void {
  if (scheduler) return;
  const run = () => {
    void runDataRetentionJob().catch((error) => {
      logger.error('Data retention scheduler failed', { error });
    });
  };
  run();
  scheduler = setInterval(run, SCHEDULER_INTERVAL_MS);
  scheduler.unref();
}

export function stopDataRetentionScheduler(): void {
  if (!scheduler) return;
  clearInterval(scheduler);
  scheduler = undefined;
}
