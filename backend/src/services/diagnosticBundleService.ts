import { Pool } from 'pg';
import { deepRedact } from '../utils/logger';
import { maskValue } from '../utils/piiCrypto';
import { auditLogService } from './auditLogService';

/**
 * Diagnostic bundle service.
 *
 * Generates privacy-safe, user-authorized diagnostic bundles for a single
 * transaction. Only allowlisted fields are ever exported; every string is run
 * through a redaction pass before serialization. Bundles expire after a short,
 * documented period (default 24h).
 */

export const DIAGNOSTIC_BUNDLE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The schema allowlist. Every exported field MUST be declared here. There is
 * no arbitrary log or database dump path.
 */
export const DIAGNOSTIC_BUNDLE_SCHEMA = {
  bundleId: 'string',
  createdAt: 'string',
  expiresAt: 'string',
  transaction: {
    id: 'string',
    txHash: 'string',
    status: 'string',
    submittedAt: 'string',
    updatedAt: 'string',
    transactionType: 'string',
    failureCategory: 'string',
  },
  auditCorrelation: 'array',
  appVersion: 'string',
} as const;

export type DiagnosticFailureCategory =
  | 'none'
  | 'pending'
  | 'validation'
  | 'network'
  | 'insufficient_funds'
  | 'rejected'
  | 'unknown';

export interface DiagnosticBundleTransaction {
  id: string;
  txHash: string;
  status: string;
  submittedAt: string;
  updatedAt: string;
  transactionType: string;
  failureCategory: DiagnosticFailureCategory;
}

export interface DiagnosticAuditCorrelation {
  action: string;
  target: string;
  createdAt: string;
}

export interface DiagnosticBundle {
  bundleId: string;
  createdAt: string;
  expiresAt: string;
  transaction: DiagnosticBundleTransaction;
  auditCorrelation: DiagnosticAuditCorrelation[];
  appVersion: string;
}

export interface DiagnosticBundleRow {
  id: string;
  transaction_id: string;
  submitted_by: string;
  bundle: DiagnosticBundle;
  created_at: Date;
  expires_at: Date;
}

export interface CreateDiagnosticBundleOptions {
  ttlMs?: number;
  appVersion?: string;
  auditActions?: string[];
}

export class DiagnosticBundleError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'DiagnosticBundleError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Redact a single string value. Uses deepRedact for pattern-based scrubbing
 * (emails, keys, tokens, XDR, addresses) and maskValue for short opaque
 * identifiers where masking is more appropriate.
 */
function redactString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (str.length === 0) {
    return '';
  }
  const redacted = deepRedact({ value: str }) as { value: unknown };
  const result = redacted && typeof redacted.value === 'string' ? redacted.value : '';
  return result;
}

/**
 * Mask a value that may be a wallet address or opaque identifier. Falls back
 * to redaction when masking is unavailable.
 */
function maskOrRedact(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (str.length === 0) {
    return '';
  }
  try {
    const masked = maskValue(str);
    if (typeof masked === 'string' && masked.length > 0) {
      return masked;
    }
  } catch {
    // fall through to redaction
  }
  return redactString(str);
}

/**
 * Derive a coarse failure category from status and result WITHOUT including
 * the raw result_xdr. Only the category is exported.
 */
export function deriveFailureCategory(
  status: string | null | undefined,
  resultXdr: string | null | undefined,
): DiagnosticFailureCategory {
  const normalizedStatus = (status || '').toLowerCase();
  if (normalizedStatus === 'success' || normalizedStatus === 'succeeded' || normalizedStatus === 'confirmed') {
    return 'none';
  }
  if (normalizedStatus === 'pending' || normalizedStatus === 'submitted' || normalizedStatus === 'processing') {
    return 'pending';
  }
  if (normalizedStatus === 'failed' || normalizedStatus === 'error' || normalizedStatus === 'rejected') {
    // We deliberately do not parse or export result_xdr. We only use its
    // presence to distinguish a rejected submission from an unknown failure.
    if (resultXdr && String(resultXdr).length > 0) {
      return 'rejected';
    }
    return 'unknown';
  }
  return 'unknown';
}

function toIsoString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString();
}

/**
 * Map a raw transaction row through the allowlist schema. Only allowlisted
 * fields are read; everything else on the row is ignored by construction.
 */
export function mapTransactionRow(row: Record<string, unknown>): DiagnosticBundleTransaction {
  return {
    id: redactString(row.id),
    txHash: redactString(row.tx_hash),
    status: redactString(row.status),
    submittedAt: toIsoString(row.submitted_at),
    updatedAt: toIsoString(row.updated_at),
    transactionType: redactString(row.transaction_type),
    failureCategory: deriveFailureCategory(
      row.status as string | null | undefined,
      row.result_xdr as string | null | undefined,
    ),
  };
}

function mapAuditRow(row: Record<string, unknown>): DiagnosticAuditCorrelation {
  return {
    action: redactString(row.action),
    target: redactString(row.target),
    createdAt: toIsoString(row.created_at),
  };
}

export class DiagnosticBundleService {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Generate a diagnostic bundle for a transaction the caller owns.
   * Requires explicit user action (this is only invoked from an authorized
   * endpoint). Returns the persisted bundle id.
   */
  async createDiagnosticBundle(
    transactionId: string,
    publicKey: string,
    options: CreateDiagnosticBundleOptions = {},
  ): Promise<{ bundleId: string; expiresAt: string }> {
    if (!transactionId || !publicKey) {
      throw new DiagnosticBundleError('invalid_request', 'transactionId and publicKey are required', 400);
    }

    const ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DIAGNOSTIC_BUNDLE_DEFAULT_TTL_MS;
    const appVersion = options.appVersion ? redactString(options.appVersion) : 'unknown';

    // Fetch ONLY allowlisted columns, scoped to the caller's ownership.
    const txResult = await this.pool.query(
      `SELECT id, tx_hash, status, submitted_at, updated_at, transaction_type, result_xdr
         FROM transaction_submissions
        WHERE id = $1 AND submitted_by = $2
        LIMIT 1`,
      [transactionId, publicKey],
    );

    if (txResult.rows.length === 0) {
      throw new DiagnosticBundleError('not_found', 'Transaction not found', 404);
    }

    const transaction = mapTransactionRow(txResult.rows[0] as Record<string, unknown>);

    // Optional audit correlation entries, filtered by action/target.
    let auditCorrelation: DiagnosticAuditCorrelation[] = [];
    const auditActions = options.auditActions && options.auditActions.length > 0 ? options.auditActions : null;
    try {
      const auditResult = await this.pool.query(
        `SELECT action, target, created_at
           FROM audit_logs
          WHERE target = $1
            AND ($2::text[] IS NULL OR action = ANY($2::text[]))
          ORDER BY created_at ASC
          LIMIT 50`,
        [transactionId, auditActions],
      );
      auditCorrelation = auditResult.rows.map((r) => mapAuditRow(r as Record<string, unknown>));
    } catch {
      // Audit correlation is best-effort; never fail bundle generation on it.
      auditCorrelation = [];
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    const bundle: DiagnosticBundle = {
      bundleId: '', // assigned after insert
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      transaction,
      auditCorrelation,
      appVersion,
    };

    // Final redaction pass over the assembled bundle before serialization.
    const safeBundle = deepRedact(bundle) as DiagnosticBundle;

    const insertResult = await this.pool.query(
      `INSERT INTO diagnostic_bundles (transaction_id, submitted_by, bundle, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [transactionId, publicKey, JSON.stringify(safeBundle), now, expiresAt],
    );

    const bundleId = String(insertResult.rows[0].id);
    safeBundle.bundleId = bundleId;

    // Persist the final bundle id back into the stored bundle.
    await this.pool.query(`UPDATE diagnostic_bundles SET bundle = $1 WHERE id = $2`, [
      JSON.stringify(safeBundle),
      bundleId,
    ]);

    // Log creation WITHOUT bundle contents.
    try {
      await auditLogService.log({
        action: 'diagnostic_bundle.created',
        actor: maskOrRedact(publicKey),
        target: transactionId,
        metadata: { bundleId, expiresAt: expiresAt.toISOString() },
      });
    } catch {
      // Audit logging must not break bundle creation.
    }

    return { bundleId, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Retrieve a diagnostic bundle, enforcing expiry and ownership.
   */
  async getDiagnosticBundle(bundleId: string, publicKey: string): Promise<DiagnosticBundle> {
    if (!bundleId || !publicKey) {
      throw new DiagnosticBundleError('invalid_request', 'bundleId and publicKey are required', 400);
    }

    const result = await this.pool.query(
      `SELECT id, transaction_id, submitted_by, bundle, created_at, expires_at
         FROM diagnostic_bundles
        WHERE id = $1 AND submitted_by = $2
        LIMIT 1`,
      [bundleId, publicKey],
    );

    if (result.rows.length === 0) {
      throw new DiagnosticBundleError('not_found', 'Diagnostic bundle not found', 404);
    }

    const row = result.rows[0] as DiagnosticBundleRow;
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new DiagnosticBundleError('expired', 'Diagnostic bundle has expired', 410);
    }

    const bundle = typeof row.bundle === 'string' ? (JSON.parse(row.bundle) as DiagnosticBundle) : row.bundle;
    return deepRedact(bundle) as DiagnosticBundle;
  }

  /**
   * Delete a diagnostic bundle owned by the caller.
   */
  async deleteDiagnosticBundle(bundleId: string, publicKey: string): Promise<void> {
    if (!bundleId || !publicKey) {
      throw new DiagnosticBundleError('invalid_request', 'bundleId and publicKey are required', 400);
    }

    const result = await this.pool.query(
      `DELETE FROM diagnostic_bundles
        WHERE id = $1 AND submitted_by = $2
        RETURNING id, transaction_id`,
      [bundleId, publicKey],
    );

    if (result.rows.length === 0) {
      throw new DiagnosticBundleError('not_found', 'Diagnostic bundle not found', 404);
    }

    const transactionId = String(result.rows[0].transaction_id);

    // Log deletion WITHOUT bundle contents.
    try {
      await auditLogService.log({
        action: 'diagnostic_bundle.deleted',
        actor: maskOrRedact(publicKey),
        target: transactionId,
        metadata: { bundleId },
      });
    } catch {
      // Audit logging must not break deletion.
    }
  }
}

export default DiagnosticBundleService;