import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

type QueryResult = { rows: unknown[]; rowCount?: number };
type QueryFunction = (text: string, params?: unknown[]) => Promise<QueryResult>;

const mockQuery: jest.MockedFunction<QueryFunction> = jest.fn();
const mockClientQuery: jest.MockedFunction<QueryFunction> = jest.fn();
const mockWithTransaction = jest.fn(
  async (callback: (client: { query: QueryFunction }) => Promise<unknown>) =>
    callback({ query: mockClientQuery }),
);

jest.unstable_mockModule('../../db/connection.js', () => ({
  query: mockQuery,
  withTransaction: mockWithTransaction,
  default: {},
}));

const {
  downloadSubjectAccessExport,
  expireSubjectAccessExports,
  processSubjectAccessExportJobs,
} = await import('../subjectAccessExportService.js');

describe('subject access export service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    mockClientQuery.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not return or disclose an export owned by another subject and audits the attempt', async () => {
    mockClientQuery.mockImplementation(async (text) => ({
      rows: text.includes('SELECT export_data') ? [] : [],
    }));

    await expect(
      downloadSubjectAccessExport(
        'a9bf0df1-6ff3-4bc9-8864-d42b60c949f6',
        'GBOTHERUSERPUBLICKEY',
      ),
    ).resolves.toBeNull();

    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("'download_requested'"),
      ['a9bf0df1-6ff3-4bc9-8864-d42b60c949f6', 'GBOTHERUSERPUBLICKEY'],
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('status ='),
      ['a9bf0df1-6ff3-4bc9-8864-d42b60c949f6', 'GBOTHERUSERPUBLICKEY'],
    );
  });

  it('completes a bounded, versioned export when one source is unavailable', async () => {
    mockQuery.mockImplementation(async (text) => {
      if (text.includes('SET status = CASE')) return { rows: [] };
      if (text.includes('RETURNING id, subject_public_key')) {
        return { rows: [{ id: 'export-id', subject_public_key: 'GBSUBJECT' }] };
      }
      if (text.includes('FROM remittances WHERE')) {
        throw new Error('simulated source outage');
      }
      if (text.includes('FROM user_profiles')) {
        return {
          rows: [
            {
              public_key: 'GBSUBJECT',
              display_name: 'Subject',
              email: 'subject@example.test',
              phone: '+10000000000',
              created_at: '2026-10-20T00:00:00.000Z',
              updated_at: '2026-10-21T00:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (text, params) => {
      if (text.includes('SET status = CASE WHEN attempts')) {
        return { rows: [] };
      }
      if (text.includes('SET status = \'completed\'')) {
        const document = JSON.parse(String(params?.[0])) as Record<string, unknown>;
        expect(document.schemaVersion).toBe('1.0');
        expect(document).toHaveProperty('categories.profile.sourceTimestamp');
        expect(document).toHaveProperty('categories.remittances.records', []);
        expect(document).toHaveProperty('incompleteSources', ['remittances']);

        const serialized = JSON.stringify(document);
        expect(serialized).not.toContain('recipient_address');
        expect(serialized).not.toContain('xdr');
        expect(serialized).not.toContain('metadata');
        expect(serialized).not.toContain('secret');
        expect(serialized).not.toContain('authentication');
        return { rows: [] };
      }
      if (text.includes("status = 'completed'")) return { rows: [{ id: 'export-id' }] };
      return { rows: [] };
    });

    await expect(processSubjectAccessExportJobs()).resolves.toBeUndefined();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $2'),
      ['GBSUBJECT', 1000],
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("'generated'"),
      ['export-id', 'GBSUBJECT'],
    );
  });

  it('expires a bounded batch of jobs, clears archive content, and respects exact legal holds', async () => {
    mockClientQuery.mockImplementation(async (text) => {
      if (text.includes('SELECT COUNT(*)::integer AS count FROM expired')) {
        return { rows: [{ count: 3 }] };
      }
      return { rows: [] };
    });

    await expect(expireSubjectAccessExports(25)).resolves.toBe(3);

    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'expired', export_data = NULL"),
      [25],
    );
    expect(mockClientQuery.mock.calls[0]?.[0]).toContain('retention_legal_holds');
    expect(mockClientQuery.mock.calls[0]?.[0]).toContain('FOR UPDATE OF e SKIP LOCKED');
    expect(mockClientQuery.mock.calls[0]?.[0]).toContain("'expired'");
  });
});
