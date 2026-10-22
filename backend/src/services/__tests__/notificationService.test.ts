import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
const mockClientQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
const mockWithTransaction = jest.fn(
  async (callback: (client: { query: typeof mockClientQuery }) => Promise<unknown>) =>
    callback({ query: mockClientQuery }),
);
const mockSendGridMail = { setApiKey: jest.fn(), send: jest.fn() };
const mockTwilioMessagesCreate = jest.fn();
const mockTwilioFactory = jest.fn(() => ({ messages: { create: mockTwilioMessagesCreate } }));

jest.unstable_mockModule('../../db/connection.js', () => ({
  query: mockQuery,
  withTransaction: mockWithTransaction,
}));

jest.unstable_mockModule('twilio', () => ({
  default: mockTwilioFactory,
}));

jest.unstable_mockModule('@sendgrid/mail', () => ({
  default: mockSendGridMail,
}));

const {
  notificationService,
  getNotificationRetryDelayMs,
} = await import('../notificationService.js');

describe('notificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTwilioMessagesCreate.mockResolvedValue({ sid: 'SM-message-id' });
    process.env.FROM_EMAIL = 'noreply@remitlend.test';
    process.env.SENDGRID_API_KEY = 'test-sendgrid-key';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest123';
    process.env.TWILIO_AUTH_TOKEN = 'token123';
    process.env.TWILIO_PHONE_NUMBER = '+15551234567';
  });

  afterEach(() => {
    delete process.env.FROM_EMAIL;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
  });

  describe('notification delivery lifecycle', () => {
    it('uses bounded jittered retry delays and retries accepted failure idempotently', async () => {
      expect(getNotificationRetryDelayMs(1, () => 0)).toBe(15_000);
      expect(getNotificationRetryDelayMs(4, () => 1)).toBe(2_700_000);
      expect(getNotificationRetryDelayMs(99, () => 1)).toBe(2_700_000);

      let attemptStatus = 'accepted';
      mockClientQuery.mockImplementation(async (sql) => {
        if (sql.includes('FROM notification_delivery_attempts')) {
          return {
            rows: [
              {
                id: 'delivery-1',
                channel: 'sms',
                status: 'accepted',
                attempt_id: 'attempt-1',
                attempt_status: attemptStatus,
                notification_created_at: new Date(Date.now() - 10_000),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('UPDATE notification_delivery_attempts')) {
          attemptStatus = 'delivered';
        }
        return { rows: [], rowCount: 1 };
      });

      const receipt = {
        provider: 'twilio' as const,
        providerMessageId: 'SM-message-id',
        status: 'delivered' as const,
      };
      await expect(notificationService.recordProviderReceipt(receipt)).resolves.toBe(true);
      await expect(notificationService.recordProviderReceipt(receipt)).resolves.toBe(true);

      expect(
        mockClientQuery.mock.calls.filter(([sql]) =>
          sql.includes('UPDATE notification_delivery_attempts'),
        ),
      ).toHaveLength(1);
    });

    it('classifies a provider timeout and exhausts retries without PII diagnostics', async () => {
      mockTwilioMessagesCreate.mockRejectedValue(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      );
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'delivery-2',
              notification_id: 9,
              channel: 'sms',
              provider: 'twilio',
              attempt_count: 5,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              user_id: 'user-retry',
              type: 'repayment_due',
              message: 'Private repayment text',
              email_enabled: false,
              sms_enabled: true,
              phone: '+15557654321',
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await notificationService.processDeliveryRetries();

      expect(mockQuery.mock.calls[3]?.[0]).toContain('INSERT INTO notification_delivery_attempts');
      expect(mockQuery.mock.calls[3]?.[1]).toEqual([
        'delivery-2',
        5,
        'twilio',
        null,
        'permanent_failure',
        'RETRY_EXHAUSTED',
      ]);
      expect(mockQuery.mock.calls[4]?.[1]?.[2]).toBe('permanent_failure');
      expect(mockQuery.mock.calls[4]?.[1]?.[3]).toBe('RETRY_EXHAUSTED');
      expect(JSON.stringify(mockQuery.mock.calls)).not.toContain('+15557654321');
      expect(JSON.stringify(mockQuery.mock.calls)).not.toContain('Private repayment text');
    });

    it('retries after provider recovery and records its new message identifier', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'delivery-3',
              notification_id: 11,
              channel: 'sms',
              provider: 'twilio',
              attempt_count: 2,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              user_id: 'user-recovered',
              type: 'repayment_due',
              message: 'Repayment reminder',
              email_enabled: false,
              sms_enabled: true,
              phone: '+15550001111',
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await notificationService.processDeliveryRetries();

      expect(mockTwilioMessagesCreate).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[3]?.[1]).toEqual([
        'delivery-3',
        2,
        'twilio',
        'SM-message-id',
        'accepted',
        null,
      ]);
      expect(mockQuery.mock.calls[4]?.[1]?.[2]).toBe('accepted');
    });
  });

  describe('createNotification', () => {
    it('sets actionUrl from loanId when not explicitly provided', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            user_id: 'user1',
            type: 'loan_approved',
            title: 'Loan Approved',
            message: 'Your loan has been approved',
            loan_id: 42,
            action_url: '/loans/42',
            read: false,
            status: 'unread',
            created_at: new Date('2026-05-28T12:00:00.000Z'),
          },
        ],
        rowCount: 1,
      });

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            email: null,
            phone: null,
            email_enabled: false,
            sms_enabled: false,
          },
        ],
        rowCount: 1,
      });

      const notification = await notificationService.createNotification({
        userId: 'user1',
        type: 'loan_approved',
        title: 'Loan Approved',
        message: 'Your loan has been approved',
        loanId: 42,
      });

      expect(notification.actionUrl).toBe('/loans/42');
      const insertCall = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(insertCall[1]).toContain('/loans/42');
    });

    it('uses explicit actionUrl over loanId when provided', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 2,
            user_id: 'user2',
            type: 'repayment_confirmed',
            title: 'Remittance Sent',
            message: 'Remittance submitted',
            loan_id: null,
            action_url: '/remittances/99',
            read: false,
            status: 'unread',
            created_at: new Date('2026-05-28T12:00:00.000Z'),
          },
        ],
        rowCount: 1,
      });

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            email: null,
            phone: null,
            email_enabled: false,
            sms_enabled: false,
          },
        ],
        rowCount: 1,
      });

      const notification = await notificationService.createNotification({
        userId: 'user2',
        type: 'repayment_confirmed',
        title: 'Remittance Sent',
        message: 'Remittance submitted',
        actionUrl: '/remittances/99',
      });

      expect(notification.actionUrl).toBe('/remittances/99');
    });

    it('returns null actionUrl when neither loanId nor actionUrl provided', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 3,
            user_id: 'user3',
            type: 'score_changed',
            title: 'Score Changed',
            message: 'Your score changed',
            loan_id: null,
            action_url: null,
            read: false,
            status: 'unread',
            created_at: new Date('2026-05-28T12:00:00.000Z'),
          },
        ],
        rowCount: 1,
      });

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            email: null,
            phone: null,
            email_enabled: false,
            sms_enabled: false,
          },
        ],
        rowCount: 1,
      });

      const notification = await notificationService.createNotification({
        userId: 'user3',
        type: 'score_changed',
        title: 'Score Changed',
        message: 'Your score changed',
      });

      expect(notification.actionUrl).toBeUndefined();
    });
  });

  describe('preferences and filtering', () => {
    it('reads and updates notification preferences for a user', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ email_enabled: true, sms_enabled: false, phone: '+14155552671' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ email_enabled: true, sms_enabled: true, phone: '+14155552671' }],
          rowCount: 1,
        });

      const prefs = await notificationService.getNotificationPreferences('user-pref-1');
      expect(prefs).toEqual({
        emailEnabled: true,
        smsEnabled: false,
        phone: '+14155552671',
        perTypeOverrides: {},
      });

      const updated = await notificationService.updateNotificationPreferences('user-pref-1', {
        emailEnabled: true,
        smsEnabled: true,
        phone: '+14155552671',
      });

      expect(updated).toEqual({
        emailEnabled: true,
        smsEnabled: true,
        phone: '+14155552671',
        perTypeOverrides: {},
      });
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('UPDATE user_profiles'),
        ['user-pref-1', true, true, '+14155552671'],
      );
    });

    it('filters notifications by type, status, and date windows', async () => {
      const from = '2026-05-01T00:00:00.000Z';
      const to = '2026-05-31T23:59:59.999Z';
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 7,
            user_id: 'user-filter-1',
            type: 'repayment_due',
            title: 'Repayment due',
            message: 'Payment scheduled',
            loan_id: null,
            action_url: null,
            read: false,
            status: 'unread',
            created_at: '2026-05-15T10:00:00.000Z',
          },
        ],
        rowCount: 1,
      });

      const notifications = await notificationService.getNotificationsForUser(
        'user-filter-1',
        25,
        'repayment_due',
        'unread',
        from,
        to,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.type).toBe('repayment_due');
      expect(notifications[0]?.status).toBe('unread');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND type = $2'),
        ['user-filter-1', 'repayment_due', 'unread', from, to, 25],
      );
    });
  });

  describe('external delivery', () => {
    it('sends email and SMS when delivery preferences are enabled for a due payment', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 9,
              user_id: 'user-delivery-1',
              type: 'repayment_due',
              title: 'Repayment due',
              message: 'Your repayment is due tomorrow',
              loan_id: 42,
              action_url: '/loans/42',
              read: false,
              status: 'unread',
              created_at: '2026-05-28T12:00:00.000Z',
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              email: 'user@example.com',
              phone: '+15557654321',
              email_enabled: true,
              sms_enabled: true,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ id: 'email-delivery' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ attempt_count: 1 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'sms-delivery' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ attempt_count: 1 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await notificationService.createNotification({
        userId: 'user-delivery-1',
        type: 'repayment_due',
        title: 'Repayment due',
        message: 'Your repayment is due tomorrow',
        loanId: 42,
      });

      expect(mockSendGridMail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          from: 'noreply@remitlend.test',
          subject: 'Repayment reminder — RemitLend',
          html: expect.stringContaining('<h2>Repayment Due Soon</h2>'),
        }),
      );
      expect(mockTwilioMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Your repayment is due tomorrow',
          from: '+15551234567',
          to: '+15557654321',
        }),
      );
    });

    it('renders the expected email template for loan approval notifications', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 11,
              user_id: 'user-template-1',
              type: 'loan_approved',
              title: 'Loan approved',
              message: 'Your loan has been approved',
              loan_id: 7,
              action_url: '/loans/7',
              read: false,
              status: 'unread',
              created_at: '2026-05-28T12:00:00.000Z',
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              email: 'approved@example.com',
              phone: null,
              email_enabled: true,
              sms_enabled: false,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ id: 'email-delivery' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ attempt_count: 1 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await notificationService.createNotification({
        userId: 'user-template-1',
        type: 'loan_approved',
        title: 'Loan approved',
        message: 'Your loan has been approved',
        loanId: 7,
      });

      expect(mockSendGridMail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Your loan has been approved — RemitLend',
          html: expect.stringContaining('<h2>Loan Approved</h2>'),
        }),
      );
      expect(mockSendGridMail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Your loan has been approved'),
        }),
      );
    });
  });

  describe('notifyAdmins', () => {
    const originalAdminWallets = process.env.ADMIN_WALLETS;
    const originalAdminEmail = process.env.ADMIN_EMAIL;

    afterEach(() => {
      if (originalAdminWallets === undefined) {
        delete process.env.ADMIN_WALLETS;
      } else {
        process.env.ADMIN_WALLETS = originalAdminWallets;
      }
      if (originalAdminEmail === undefined) {
        delete process.env.ADMIN_EMAIL;
      } else {
        process.env.ADMIN_EMAIL = originalAdminEmail;
      }
    });

    const makeNotificationRow = (userId: string, loanId: number | null) => ({
      id: 1,
      user_id: userId,
      type: 'loan_defaulted',
      title: 'Loan Default',
      message: 'A loan has defaulted',
      loan_id: loanId,
      action_url: loanId != null ? `/loans/${loanId}` : null,
      read: false,
      status: 'unread',
      created_at: new Date('2026-05-28T12:00:00.000Z'),
    });

    it('inserts a notification for each wallet in ADMIN_WALLETS without querying role', async () => {
      process.env.ADMIN_WALLETS = 'wallet1,wallet2';
      delete process.env.ADMIN_EMAIL;

      mockQuery
        .mockResolvedValueOnce({
          rows: [makeNotificationRow('wallet1', 99)],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [makeNotificationRow('wallet2', 99)],
          rowCount: 1,
        });

      await notificationService.notifyAdmins({
        title: 'Loan Default',
        message: 'A loan has defaulted',
        loanId: 99,
      });

      const sqls = (mockQuery.mock.calls as [string, unknown[]][]).map((c) => c[0]);
      expect(sqls.some((s) => s.includes('WHERE role'))).toBe(false);
      expect(mockQuery).toHaveBeenCalledTimes(2);

      const params0 = (mockQuery.mock.calls[0]?.[1] ?? []) as unknown[];
      const params1 = (mockQuery.mock.calls[1]?.[1] ?? []) as unknown[];
      expect(params0[0]).toBe('wallet1');
      expect(params1[0]).toBe('wallet2');
    });

    it('does nothing when ADMIN_WALLETS is unset', async () => {
      delete process.env.ADMIN_WALLETS;
      delete process.env.ADMIN_EMAIL;

      await notificationService.notifyAdmins({
        title: 'Test',
        message: 'Test',
      });

      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('does nothing when ADMIN_WALLETS is empty or whitespace-only', async () => {
      process.env.ADMIN_WALLETS = ' , , ';
      delete process.env.ADMIN_EMAIL;

      await notificationService.notifyAdmins({
        title: 'Test',
        message: 'Test',
      });

      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
