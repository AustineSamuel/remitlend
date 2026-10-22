import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

type QueryResult = { rows: unknown[] };
type QueryFunction = (text: string, params?: unknown[]) => Promise<QueryResult>;

const clientQuery: jest.MockedFunction<QueryFunction> = jest.fn();
const mockWithTransaction = jest.fn(
  async (callback: (client: { query: QueryFunction }) => Promise<unknown>) =>
    callback({ query: clientQuery }),
);
const mockEncryptField = jest.fn(async (_secret: string) => ({
  ciphertext: Buffer.from('ciphertext'),
  gcm_nonce: Buffer.from('nonce'),
  dek_wrapped: Buffer.from('wrapped'),
  dek_kek_id: 'test-kek',
}));

jest.unstable_mockModule('../../db/connection.js', () => ({
  withTransaction: mockWithTransaction,
  query: jest.fn(),
  default: {},
}));

jest.unstable_mockModule('../piiCrypto.js', () => ({
  encryptField: mockEncryptField,
}));

const {
  activateWebhookSigningKey,
  getMaxWebhookKeyOverlapSeconds,
  rollbackWebhookSigningKey,
  rotateWebhookSigningKey,
  WebhookKeyRotationError,
  retirePreviousWebhookKey,
} = await import('../webhookKeyRotationService.js');

const subscriptionRow = { id: 7, secret: null };

function setQueryRows(handler: (text: string, params?: unknown[]) => unknown[]) {
  clientQuery.mockImplementation(async (text, params) => ({
    rows: handler(text, params),
  }));
}

describe('webhook signing-key rotation', () => {
  const originalMaxOverlap = process.env.WEBHOOK_MAX_KEY_OVERLAP_SECONDS;

  beforeEach(() => {
    jest.clearAllMocks();
    setQueryRows((text) => {
      if (text.includes('FROM webhook_subscriptions')) return [subscriptionRow];
      if (text.includes('idempotency_key =')) return [];
      if (text.includes("state = 'next'")) return [];
      if (text.includes("state = 'previous'")) return [];
      if (text.includes("state = 'current'")) return [{ id: 'current-key-id' }];
      return [];
    });
  });

  afterEach(() => {
    if (originalMaxOverlap === undefined) {
      delete process.env.WEBHOOK_MAX_KEY_OVERLAP_SECONDS;
    } else {
      process.env.WEBHOOK_MAX_KEY_OVERLAP_SECONDS = originalMaxOverlap;
    }
  });

  it('stages a new key without activating it and replays idempotently without the secret', async () => {
    const staged = await rotateWebhookSigningKey(7, 'owner-key', 'rotation-key-0001', 600);

    expect(staged.secret).toBeDefined();
    expect(staged.replayed).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("'next'"),
      expect.arrayContaining(['rotation-key-0001', 600]),
    );
    expect(
      clientQuery.mock.calls.some(([sql]) =>
        String(sql).includes("SET state = 'previous'"),
      ),
    ).toBe(false);

    setQueryRows((text) => {
      if (text.includes('FROM webhook_subscriptions')) return [subscriptionRow];
      if (text.includes('idempotency_key =')) return [{ id: staged.keyId }];
      return [];
    });
    const replay = await rotateWebhookSigningKey(7, 'owner-key', 'rotation-key-0001', 600);

    expect(replay).toEqual({ keyId: staged.keyId, replayed: true });
    expect(replay.secret).toBeUndefined();
  });

  it('activates the staged key with a bounded deadline and retires the old key on confirmation', async () => {
    process.env.WEBHOOK_MAX_KEY_OVERLAP_SECONDS = '3600';
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    setQueryRows((text) => {
      if (text.includes('FROM webhook_subscriptions')) return [{ id: 7 }];
      if (text.includes('overlap_seconds')) return [{ id: 'new-key-id', overlap_seconds: 600 }];
      if (text.includes("state = 'current'")) return [{ id: 'old-key-id' }];
      return [];
    });

    const activation = await activateWebhookSigningKey(7, 'owner-key', 'new-key-id');
    expect(activation.overlapExpiresAt).toEqual(new Date(1_800_000_600_000));
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET state = 'previous'"),
      [new Date(1_800_000_600_000), 'old-key-id'],
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET state = 'current'"),
      ['new-key-id'],
    );

    clientQuery.mockClear();
    setQueryRows((text) => {
      if (text.includes("state = 'current'")) return [{ id: 'new-key-id' }];
      return [];
    });
    await retirePreviousWebhookKey(7, 'new-key-id');
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET state = 'retired'"),
      [7],
    );
  });

  it('rolls back only a staged key and makes repeated rollback safe', async () => {
    setQueryRows((text) => {
      if (text.includes('FROM webhook_subscriptions')) return [subscriptionRow];
      if (text.includes("state = 'next'")) return [{ id: 'staged-key-id' }];
      return [];
    });

    await expect(rollbackWebhookSigningKey(7, 'owner-key', 'staged-key-id')).resolves.toBeUndefined();
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET state = 'retired'"),
      ['staged-key-id'],
    );

    setQueryRows((text) => {
      if (text.includes('FROM webhook_subscriptions')) return [subscriptionRow];
      if (text.includes("state = 'next'")) return [];
      if (text.includes("state = 'retired'")) return [{ id: 'staged-key-id' }];
      return [];
    });
    await expect(rollbackWebhookSigningKey(7, 'owner-key', 'staged-key-id')).resolves.toBeUndefined();
  });

  it('rejects another concurrent rotation while a key is staged', async () => {
    setQueryRows((text) => {
      if (text.includes('FROM webhook_subscriptions')) return [subscriptionRow];
      if (text.includes("state = 'next'")) return [{ id: 'already-staged' }];
      return [];
    });

    await expect(
      rotateWebhookSigningKey(7, 'owner-key', 'rotation-key-0002', 600),
    ).rejects.toMatchObject({
      code: 'overlap_in_progress',
    });
  });

  it('rejects overlap durations above the configured maximum', async () => {
    process.env.WEBHOOK_MAX_KEY_OVERLAP_SECONDS = '60';
    expect(getMaxWebhookKeyOverlapSeconds()).toBe(60);
    await expect(
      rotateWebhookSigningKey(7, 'owner-key', 'rotation-key-0003', 61),
    ).rejects.toBeInstanceOf(WebhookKeyRotationError);
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });
});
