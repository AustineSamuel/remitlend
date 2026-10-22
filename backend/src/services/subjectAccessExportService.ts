import crypto from 'node:crypto';
import { query, withTransaction } from '../db/connection.js';
import logger from '../utils/logger.js';

const EXPORT_VERSION = '1.0';
const EXPORT_TTL_HOURS = 24;
const MAX_ROWS_PER_CATEGORY = 1000;
const MAX_ATTEMPTS = 3;

interface ExportCategory {
  source: string;
  sourceTimestamp: string;
  truncated: boolean;
  records: unknown[];
}

interface SubjectExport {
  schemaVersion: string;
  subject: { publicKey: string };
  generatedAt: string;
  categories: Record<string, ExportCategory>;
  incompleteSources: string[];
}

export interface SubjectAccessExportJob {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export class SubjectAccessExportConflictError extends Error {
  constructor() {
    super('An active subject access export already exists');
    this.name = 'SubjectAccessExportConflictError';
  }
}

const categories = [
  {
    name: 'profile',
    source: 'user_profiles',
    sql: `SELECT public_key, display_name, email, phone, email_enabled, sms_enabled,
                 created_at, updated_at
          FROM user_profiles WHERE public_key = $1 LIMIT 1`,
  },
  {
    name: 'remittances',
    source: 'remittances',
    sql: `SELECT id, amount, from_currency, to_currency, status,
                 transaction_hash, created_at, updated_at
          FROM remittances WHERE sender_id = $1 ORDER BY created_at DESC LIMIT $2`,
  },
  {
    name: 'remittanceHistory',
    source: 'remittance_history',
    sql: `SELECT amount, month, status, created_at
          FROM remittance_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
  },
  {
    name: 'score',
    source: 'scores',
    sql: `SELECT COALESCE(to_jsonb(s)->>'score', to_jsonb(s)->>'current_score') AS score,
                 updated_at
          FROM scores s
          WHERE COALESCE(to_jsonb(s)->>'borrower', to_jsonb(s)->>'user_id') = $1
          LIMIT 1`,
  },
  {
    name: 'loans',
    source: 'loan_history',
    sql: `SELECT loan_id, principal_amount, interest_rate_bps, principal_paid,
                 interest_paid, accrued_interest, status, due_date, requested_at,
                 approved_at, repaid_at, defaulted_at, created_at, updated_at
          FROM loan_history
          WHERE borrower_public_key = $1
          ORDER BY created_at DESC LIMIT $2`,
  },
  {
    name: 'loanEvents',
    source: 'loan_events',
    sql: `SELECT loan_id, event_type, amount, ledger, created_at
          FROM loan_events WHERE borrower = $1 ORDER BY created_at DESC LIMIT $2`,
  },
  {
    name: 'notifications',
    source: 'notifications',
    sql: `SELECT type, read, created_at
          FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
  },
  {
    name: 'accountAudit',
    source: 'audit_logs',
    sql: `SELECT action, created_at
          FROM audit_logs WHERE actor = $1 ORDER BY created_at DESC LIMIT $2`,
  },
] as const;

function categoryTimestamp(records: unknown[], fallback: Date): string {
  let latest = fallback;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const timestamp = (record as Record<string, unknown>).updated_at ??
      (record as Record<string, unknown>).created_at;
    if (!timestamp) continue;
    const parsed = new Date(String(timestamp));
    if (!Number.isNaN(parsed.getTime()) && parsed > latest) latest = parsed;
  }
  return latest.toISOString();
}

async function generateExport(subjectPublicKey: string): Promise<SubjectExport> {
  const generatedAt = new Date();
  const exportCategories: SubjectExport['categories'] = {};
  const incompleteSources: string[] = [];

  await Promise.all(
    categories.map(async (category) => {
      try {
        const params =
          category.name === 'profile' || category.name === 'score'
            ? [subjectPublicKey]
            : [subjectPublicKey, MAX_ROWS_PER_CATEGORY];
        const result = await query(category.sql, params);
        const records = result.rows as unknown[];
        exportCategories[category.name] = {
          source: category.source,
          sourceTimestamp: categoryTimestamp(records, generatedAt),
          truncated: records.length === MAX_ROWS_PER_CATEGORY,
          records,
        };
      } catch (error) {
        logger.warn('Subject access export source failed', {
          source: category.source,
          error,
        });
        incompleteSources.push(category.source);
        exportCategories[category.name] = {
          source: category.source,
          sourceTimestamp: generatedAt.toISOString(),
          truncated: false,
          records: [],
        };
      }
    }),
  );

  return {
    schemaVersion: EXPORT_VERSION,
    subject: { publicKey: subjectPublicKey },
    generatedAt: generatedAt.toISOString(),
    categories: exportCategories,
    incompleteSources: incompleteSources.sort(),
  };
}

export async function createSubjectAccessExport(
  subjectPublicKey: string,
): Promise<SubjectAccessExportJob> {
  const expiresAt = new Date(Date.now() + EXPORT_TTL_HOURS * 60 * 60 * 1000);
  const id = crypto.randomUUID();

  try {
    return await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO subject_access_exports
           (id, subject_public_key, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (subject_public_key)
           WHERE status IN ('queued', 'processing')
           DO NOTHING
         RETURNING id, status, created_at, expires_at`,
        [id, subjectPublicKey, expiresAt],
      );
      const row = inserted.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        throw new SubjectAccessExportConflictError();
      }
      await client.query(
        `INSERT INTO subject_access_export_audit (export_id, subject_public_key, action)
         VALUES ($1, $2, 'requested')`,
        [id, subjectPublicKey],
      );
      return mapJob(row);
    });
  } catch (error) {
    const active = await query(
      `SELECT id, status, created_at, expires_at
       FROM subject_access_exports
       WHERE subject_public_key = $1 AND status IN ('queued', 'processing')
       ORDER BY created_at DESC LIMIT 1`,
      [subjectPublicKey],
    );
    if (active.rows.length > 0) {
      await query(
        `INSERT INTO subject_access_export_audit (export_id, subject_public_key, action)
         VALUES ($1, $2, 'request_denied')`,
        [String((active.rows[0] as Record<string, unknown>).id), subjectPublicKey],
      );
      throw new SubjectAccessExportConflictError();
    }
    throw error;
  }
}

function mapJob(row: Record<string, unknown>): SubjectAccessExportJob {
  return {
    id: String(row.id),
    status: String(row.status) as SubjectAccessExportJob['status'],
    createdAt: new Date(String(row.created_at)).toISOString(),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
  };
}

export async function getSubjectAccessExport(
  exportId: string,
  subjectPublicKey: string,
): Promise<SubjectAccessExportJob | null> {
  const result = await query(
    `SELECT id, status, created_at, expires_at
     FROM subject_access_exports
     WHERE id = $1 AND subject_public_key = $2 AND expires_at > CURRENT_TIMESTAMP`,
    [exportId, subjectPublicKey],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapJob(row) : null;
}

export async function downloadSubjectAccessExport(
  exportId: string,
  subjectPublicKey: string,
): Promise<SubjectExport | null> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO subject_access_export_audit (export_id, subject_public_key, action)
       SELECT CASE WHEN EXISTS (
         SELECT 1 FROM subject_access_exports WHERE id = $1
       ) THEN $1::uuid ELSE NULL END, $2, 'download_requested'`,
      [exportId, subjectPublicKey],
    );
    const result = await client.query(
      `SELECT export_data
       FROM subject_access_exports
       WHERE id = $1 AND subject_public_key = $2
         AND status = 'completed' AND expires_at > CURRENT_TIMESTAMP
       FOR UPDATE`,
      [exportId, subjectPublicKey],
    );
    const row = result.rows[0] as { export_data: SubjectExport | null } | undefined;
    if (!row?.export_data) {
      await client.query(
        `INSERT INTO subject_access_export_audit (export_id, subject_public_key, action)
         SELECT CASE WHEN EXISTS (
           SELECT 1 FROM subject_access_exports WHERE id = $1
         ) THEN $1::uuid ELSE NULL END, $2, 'access_denied'`,
        [exportId, subjectPublicKey],
      );
      return null;
    }
    await client.query(
      `INSERT INTO subject_access_export_audit (export_id, subject_public_key, action)
       VALUES ($1, $2, 'downloaded')`,
      [exportId, subjectPublicKey],
    );
    return row.export_data;
  });
}

export async function processSubjectAccessExportJobs(): Promise<void> {
  await expireSubjectAccessExports();
  await query(
    `WITH recovered AS (
       UPDATE subject_access_exports
       SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
           available_at = CURRENT_TIMESTAMP
       WHERE status = 'processing'
         AND started_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
       RETURNING id, subject_public_key, status
     )
     INSERT INTO subject_access_export_audit (export_id, subject_public_key, action)
     SELECT id, subject_public_key,
            CASE WHEN status = 'failed' THEN 'failed' ELSE 'retry_scheduled' END
     FROM recovered`,
    [MAX_ATTEMPTS],
  );
  for (let count = 0; count < 5; count++) {
    const claimed = await query(
      `UPDATE subject_access_exports
       SET status = 'processing', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM subject_access_exports
         WHERE status = 'queued' AND available_at <= CURRENT_TIMESTAMP
           AND expires_at > CURRENT_TIMESTAMP AND attempts < $1
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, subject_public_key`,
      [MAX_ATTEMPTS],
    );
    const row = claimed.rows[0] as { id: string; subject_public_key: string } | undefined;
    if (!row) break;

    try {
      const exportData = await generateExport(row.subject_public_key);
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE subject_access_exports
           SET status = 'completed', export_data = $1::jsonb, completed_at = CURRENT_TIMESTAMP,
               source_errors = $2::jsonb
           WHERE id = $3 AND status = 'processing'`,
          [
            JSON.stringify(exportData),
            JSON.stringify(exportData.incompleteSources),
            row.id,
          ],
        );
        const saved = await client.query(
          `SELECT id FROM subject_access_exports WHERE id = $1 AND status = 'completed'`,
          [row.id],
        );
        if (saved.rows.length === 0) return;
        await client.query(
          `INSERT INTO subject_access_export_audit (export_id, subject_public_key, action)
           VALUES ($1, $2, 'generated')`,
          [row.id, row.subject_public_key],
        );
      });
    } catch (error) {
      logger.error('Subject access export generation failed', { exportId: row.id, error });
      await withTransaction(async (client) => {
        const failed = await client.query(
          `UPDATE subject_access_exports
           SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
               available_at = CURRENT_TIMESTAMP + INTERVAL '30 seconds'
           WHERE id = $2 AND status = 'processing'
           RETURNING status`,
          [MAX_ATTEMPTS, row.id],
        );
        const status = (failed.rows[0] as { status: string } | undefined)?.status;
        if (!status) return;
        await client.query(
          `INSERT INTO subject_access_export_audit (export_id, subject_public_key, action)
           VALUES ($1, $2, $3)`,
          [row.id, row.subject_public_key, status === 'failed' ? 'failed' : 'retry_scheduled'],
        );
      });
    }
  }
}

export async function expireSubjectAccessExports(): Promise<void> {
  await withTransaction(async (client) => {
    const expired = await client.query(
      `UPDATE subject_access_exports
       SET status = 'expired', export_data = NULL
       WHERE expires_at <= CURRENT_TIMESTAMP AND status <> 'expired'
       RETURNING id, subject_public_key`,
    );
    for (const row of expired.rows as Array<{ id: string; subject_public_key: string }>) {
      await client.query(
        `INSERT INTO subject_access_export_audit (export_id, subject_public_key, action)
         VALUES ($1, $2, 'expired')`,
        [row.id, row.subject_public_key],
      );
    }
  });
}

let processorInterval: NodeJS.Timeout | null = null;

export function startSubjectAccessExportProcessor(): void {
  if (processorInterval) return;
  processorInterval = setInterval(() => {
    processSubjectAccessExportJobs().catch((error) => {
      logger.error('Subject access export processor failed', { error });
    });
  }, 10_000);
  processorInterval.unref();
  void processSubjectAccessExportJobs().catch((error) => {
    logger.error('Subject access export processor failed', { error });
  });
}

export function stopSubjectAccessExportProcessor(): void {
  if (!processorInterval) return;
  clearInterval(processorInterval);
  processorInterval = null;
}
