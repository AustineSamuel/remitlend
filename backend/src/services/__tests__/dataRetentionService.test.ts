import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number | null };
type QueryFunction = (sql: string, params?: unknown[]) => Promise<QueryResult>;

const mockQuery = jest.fn<QueryFunction>();
const mockClientQuery = jest.fn<QueryFunction>();
const mockWithTransaction = jest.fn(
  async (callback: (client: { query: QueryFunction }) => Promise<unknown>) =>
    callback({ query: mockClientQuery }),
);
const mockCacheDeleteForRetention = jest.fn();
const mockRowsProcessedInc = jest.fn();
const mockRunsInc = jest.fn();

jest.unstable_mockModule('../../db/connection.js', () => ({
  query: mockQuery,
  withTransaction: mockWithTransaction,
}));

jest.unstable_mockModule('../cacheService.js', () => ({
  cacheService: { deleteForRetention: mockCacheDeleteForRetention },
}));

jest.unstable_mockModule('../../middleware/metrics.js', () => ({
  retentionRowsProcessedCounter: { inc: mockRowsProcessedInc },
  retentionJobRunsCounter: { inc: mockRunsInc },
}));

const {
  createRetentionLegalHold,
  RETENTION_POLICIES,
  runDataRetentionJob,
} = await import('../dataRetentionService.js');

describe('data retention service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheDeleteForRetention.mockResolvedValue(true);
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('UPDATE retention_job_lease')) return { rows: [{ id: 1 }] };
      if (sql.includes('FROM retention_cache_invalidations')) return { rows: [{ count: 0 }] };
      return { rows: [], rowCount: 0 };
    });
    mockClientQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT COUNT(*)::integer AS count FROM expired')) {
        return { rows: [{ count: 2 }] };
      }
      if (sql.includes('SELECT (SELECT COUNT(*) FROM anonymized)')) {
        return { rows: [{ affected_count: 3 }] };
      }
      if (sql.includes('UPDATE retention_cache_invalidations')) {
        return {
          rows: [
            { id: 41, cache_kind: 'borrower_loans', subject_key: 'GBTESTSUBJECT' },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs bounded policy batches with audit checkpoints and expunges exports and derived cache data', async () => {
    const result = await runDataRetentionJob(new Date('2026-10-22T00:00:00.000Z'));

    expect(result.status).toBe('completed');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO retention_job_runs'),
      [result.id],
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'expired', export_data = NULL"),
      [100],
    );
    const remittanceAnonymization = mockClientQuery.mock.calls.find(([sql]) =>
      sql.includes('UPDATE remittances r'),
    );
    expect(remittanceAnonymization?.[0]).toContain('recipient_address = NULL');
    expect(remittanceAnonymization?.[0]).toContain('memo = NULL');
    expect(remittanceAnonymization?.[0]).toContain('xdr = NULL');
    expect(remittanceAnonymization?.[0]).toContain('retention_legal_holds');
    expect(mockCacheDeleteForRetention).toHaveBeenCalledWith(
      'borrower:loans:GBTESTSUBJECT',
    );
    expect(mockQuery).toHaveBeenCalledWith(
      'DELETE FROM retention_cache_invalidations WHERE id = $1',
      [41],
    );
    expect(mockClientQuery.mock.calls.some(([sql]) => sql.includes('retention_job_run_classes'))).toBe(
      true,
    );
    expect(JSON.stringify(mockRowsProcessedInc.mock.calls)).not.toContain('GBTESTSUBJECT');
    expect(mockRunsInc).toHaveBeenCalledWith({ outcome: 'completed' });
  });

  it('records an audited, single-record legal hold only for an existing record', async () => {
    mockClientQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM notifications')) return { rows: [{ id: 123 }] };
      if (sql.includes('INSERT INTO retention_legal_holds')) return { rows: [{ id: 'hold-1' }] };
      return { rows: [], rowCount: 0 };
    });

    const id = await createRetentionLegalHold({
      dataClass: 'notifications',
      recordId: '123',
      basis: 'Preserve this specific record for an active legal matter.',
      actor: 'admin-wallet',
    });

    expect(id).toBe('hold-1');
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO retention_legal_hold_audit'),
      ['hold-1', 'admin-wallet', 'Preserve this specific record for an active legal matter.'],
    );
  });

  it('defines an explicit cutoff and operation for every scheduled class', () => {
    expect(RETENTION_POLICIES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dataClass: 'remittances',
          years: 5,
          operation: 'anonymize',
        }),
        expect.objectContaining({
          dataClass: 'loan_events',
          years: 7,
          operation: 'soft_delete_then_delete',
        }),
        expect.objectContaining({
          dataClass: 'subject_access_exports',
          days: 1,
          operation: 'expire_archive',
        }),
      ]),
    );
    expect(new Set(RETENTION_POLICIES.map((policy) => policy.dataClass)).size).toBe(
      RETENTION_POLICIES.length,
    );
  });
});
