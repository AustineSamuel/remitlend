import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { requireJwtAuth, requireRoles, requireScopes } from '../middleware/jwtAuth.js';
import { strictRateLimiter } from '../middleware/rateLimiter.js';
import { validateBody } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { auditLog } from '../middleware/auditLog.js';
import { defaultChecker } from '../services/defaultChecker.js';
import {
  createWebhookSubscription,
  activateWebhookSubscriptionKey,
  deleteWebhookSubscription,
  getWebhookDeliveries,
  listWebhookDeadLetters,
  redriveWebhookDelivery,
  listQuarantinedEvents,
  listWebhookSubscriptions,
  reprocessQuarantinedEvents,
  reindexLedgerRange,
  rollbackWebhookSubscriptionKey,
  rotateWebhookSubscriptionKey,
  updateWebhookSubscription,
} from '../controllers/indexerController.js';
import {
  listLoanDisputes,
  resolveLoanDispute,
  getLoanDispute,
  rejectLoanDispute,
} from '../controllers/adminDisputeController.js';
import { getPendingGovernance } from '../controllers/adminGovernanceController.js';
import { getContractVerificationStatus } from '../controllers/adminContractVerificationController.js';
import { query } from '../db/connection.js';

import { buildRejectLoanTx } from '../controllers/loanController.js';
import { listAuditLogs } from '../controllers/authController.js';
import {
  listLoanStateEventsEndpoint,
  replayLoanStateEndpoint,
} from '../controllers/loanStateEventController.js';

import { listDiscrepancies } from '../services/discrepancyLedgerService.js';
import {
  createRequest as createPrivilegedRequest,
  approveRequest as approvePrivilegedRequest,
  revokeRequest as revokePrivilegedRequest,
  executeRequest as executePrivilegedRequest,
  getRequest as getPrivilegedRequest,
} from '../services/privilegedActionService.js';
import { AppError } from '../errors/AppError.js';

const router = Router();

router.get('/audit-logs', requireJwtAuth, requireRoles('admin'), listAuditLogs);

router.post(
  '/loans/:loanId/build-reject',
  requireJwtAuth,
  requireRoles('admin'),
  auditLog,
  buildRejectLoanTx,
);
/**
 * @swagger
 * /admin/loan-disputes:
 *   get:
 *     summary: List open loan disputes
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of open disputes
 *
 * /admin/loan-disputes/{disputeId}/resolve:
 *   post:
 *     summary: Resolve a loan dispute (confirm or reverse default)
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: disputeId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *               - resolution
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [confirm, reverse]
 *                 description: Action to take on the dispute
 *               resolution:
 *                 type: string
 *                 description: Detailed reason for resolution (minimum 5 characters)
 *               adminNote:
 *                 type: string
 *                 description: Optional admin note visible to borrower
 *     responses:
 *       200:
 *         description: Dispute resolved and borrower notified
 *       400:
 *         description: Validation error
 */
router.get('/loan-disputes', requireApiKey('admin:disputes'), listLoanDisputes);
router.post(
  '/loan-disputes/:disputeId/resolve',
  requireApiKey('admin:disputes'),
  resolveLoanDispute,
);
// New admin JWT-protected endpoints
router.get('/disputes', requireJwtAuth, requireRoles('admin'), listLoanDisputes);
router.get('/disputes/:disputeId', requireJwtAuth, requireRoles('admin'), getLoanDispute);
router.post(
  '/disputes/:disputeId/resolve',
  requireJwtAuth,
  requireRoles('admin'),
  resolveLoanDispute,
);
router.post(
  '/disputes/:disputeId/reject',
  requireJwtAuth,
  requireRoles('admin'),
  rejectLoanDispute,
);

router.get('/governance/pending', requireJwtAuth, requireRoles('admin'), getPendingGovernance);

/**
 * @swagger
 * /admin/contracts/verification-status:
 *   get:
 *     summary: Stellar explorer verification status for deployed contracts
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Aggregate verification stats and per-contract status
 */
router.get(
  '/contracts/verification-status',
  requireJwtAuth,
  requireRoles('admin'),
  getContractVerificationStatus,
);

const checkDefaultsBodySchema = z.object({
  loanIds: z
    .array(z.number().int().positive())
    .max(1000, 'max 1000 loan IDs per request')
    .optional(),
});

/**
 * @swagger
 * /admin/check-defaults:
 *   post:
 *     summary: Trigger manual on-chain default checks for a set of loans
 *     description: >
 *       Calls the LoanManager `check_defaults` contract function for the
 *       provided loan IDs (or all overdue loans if IDs are omitted).
 *       Bounded to a maximum of 1000 IDs per request for security.
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               loanIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 maxItems: 1000
 *                 description: Explicit list of loan IDs to check
 *     responses:
 *       200:
 *         description: Default check run completed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DefaultCheckRunResult'
 *       400:
 *         description: Validation error or too many IDs
 */
router.post(
  '/check-defaults',
  requireApiKey('admin:loans'),
  strictRateLimiter,
  auditLog,
  validateBody(checkDefaultsBodySchema),
  asyncHandler(async (req, res) => {
    const result = await defaultChecker.checkOverdueLoans(req.body.loanIds);
    res.json(result);
  }),
);

/**
 * @swagger
 * /admin/loans/{loanId}/replay-state:
 *   get:
 *     summary: Reconstruct loan state by replaying its event log
 *     description: >
 *       Admin endpoint (issue #75) that rebuilds a loan's current state by
 *       replaying its append-only loan state events. Returns the folded
 *       snapshot and the full ordered event list for auditability.
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: loanId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Reconstructed loan state
 *       400:
 *         description: Invalid loan ID
 */
router.get('/loans/:loanId/replay-state', requireApiKey('admin:loans'), replayLoanStateEndpoint);

/**
 * @swagger
 * /admin/loans/{loanId}/state-events:
 *   get:
 *     summary: List raw loan state events
 *     description: >
 *       Returns the append-only loan state events for a loan in chronological
 *       order, supporting `?limit=` and `?beforeId=` cursor pagination.
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: loanId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *       - in: query
 *         name: beforeId
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Loan state events retrieved
 *       400:
 *         description: Invalid loan ID
 */
router.get(
  '/loans/:loanId/state-events',
  requireApiKey('admin:loans'),
  listLoanStateEventsEndpoint,
);

/**
 * @swagger
 * /admin/reindex:
 *   post:
 *     summary: Backfill/reindex contract events for a ledger range
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: fromLedger
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: toLedger
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Reindex completed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReindexResponse'
 */
router.post(
  '/reindex',
  requireApiKey('admin:indexer'),
  strictRateLimiter,
  auditLog,
  reindexLedgerRange,
);

/**
 * @swagger
 * /admin/quarantine-events:
 *   get:
 *     summary: List quarantined indexer events
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: cursor
 *         required: false
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Quarantined events retrieved
 */
router.get('/quarantine-events', requireApiKey('admin:indexer'), listQuarantinedEvents);

/**
 * @swagger
 * /admin/quarantine-events/reprocess:
 *   post:
 *     summary: Reprocess quarantined indexer events
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *               limit:
 *                 type: integer
 *                 default: 50
 *     responses:
 *       200:
 *         description: Reprocess attempt completed
 */
router.post(
  '/quarantine-events/reprocess',
  requireApiKey('admin:indexer'),
  strictRateLimiter,
  auditLog,
  reprocessQuarantinedEvents,
);

/**
 * @swagger
 * /admin/webhooks:
 *   post:
 *     summary: Register a webhook subscription
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [callbackUrl, eventTypes]
 *             properties:
 *               callbackUrl:
 *                 type: string
 *               eventTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *               secret:
 *                 type: string
 *     responses:
 *       201:
 *         description: Subscription created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WebhookSubscriptionResponse'
 */
router.post(
  '/webhooks',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  createWebhookSubscription,
);

router.post(
  '/webhooks/:id/rotate-key',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  rotateWebhookSubscriptionKey,
);
router.post(
  '/webhooks/:id/activate-key',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  activateWebhookSubscriptionKey,
);
router.post(
  '/webhooks/:id/rollback-key',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  rollbackWebhookSubscriptionKey,
);

/**
 * @swagger
 * /admin/webhooks:
 *   get:
 *     summary: List webhook subscriptions
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of subscriptions
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WebhookSubscriptionListResponse'
 */
router.get('/webhooks', requireJwtAuth, requireScopes('read:webhooks'), listWebhookSubscriptions);

/**
 * @swagger
 * /admin/webhooks/{id}:
 *   delete:
 *     summary: Remove a webhook subscription
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Subscription deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessMessageResponse'
 */
router.delete(
  '/webhooks/:id',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  deleteWebhookSubscription,
);

router.put(
  '/webhooks/:id',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  updateWebhookSubscription,
);
router.get(
  '/webhooks/:id/audit',
  requireJwtAuth,
  requireScopes('read:webhooks'),
  getWebhookSubscriptionAudit,
);

/**
 * @swagger
 * /admin/webhooks/{id}/deliveries:
 *   get:
 *     summary: View webhook delivery history
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Delivery history returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WebhookDeliveriesResponse'
 */
router.get(
  '/webhooks/:id/deliveries',
  requireJwtAuth,
  requireScopes('read:webhooks'),
  getWebhookDeliveries,
);

/**
 * @swagger
 * /admin/webhooks/retry-status:
 *   get:
 *     summary: Get status of failed webhooks and retry queue
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Retry status information
 */
router.get(
  '/webhooks/retry-status',
  requireApiKey('admin:webhooks'),
  asyncHandler(async (_req, res) => {
    const result = await query(`
      SELECT 
        COUNT(*) as total_failed,
        COUNT(*) FILTER (WHERE attempt_count >= 5) as permanently_failed,
        COUNT(*) FILTER (WHERE next_retry_at IS NOT NULL) as pending_retry
      FROM webhook_deliveries
      WHERE delivered_at IS NULL
    `);

    res.json(result.rows[0]);
  }),
);

/**
 * @swagger
 * /admin/webhooks/dead-letters:
 *   get:
 *     summary: List dead-lettered webhook deliveries (redacted)
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: Dead-lettered deliveries
 */
router.get(
  '/webhooks/dead-letters',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(listWebhookDeadLetters),
);

/**
 * @swagger
 * /admin/webhooks/deliveries/{deliveryId}/redrive:
 *   post:
 *     summary: Re-drive a dead-lettered webhook delivery
 *     description: Takes no body. Target URL and payload cannot be changed.
 *     tags: [Admin]
 *     responses:
 *       202:
 *         description: Delivery re-queued with an incremented generation
 *       409:
 *         description: Delivery is not dead-lettered
 */
router.post(
  '/webhooks/deliveries/:deliveryId/redrive',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  asyncHandler(redriveWebhookDelivery),
);

/**
 * @swagger
 * /admin/discrepancies:
 *   get:
 *     summary: Read-only view of the reconciliation discrepancy ledger
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: Discrepancy records
 */
router.get(
  '/discrepancies',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit);
    const rows = await listDiscrepancies({
      ...(typeof req.query.status === 'string' ? { status: req.query.status } : {}),
      ...(typeof req.query.severity === 'string' ? { severity: req.query.severity } : {}),
      ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
    });
    res.json({ success: true, data: { discrepancies: rows } });
  }),
);

const resolveDiscrepancySchema = z.object({
  reason: z.string().min(10),
  evidence: z.record(z.string(), z.unknown()),
});

/**
 * @swagger
 * /admin/discrepancies/{id}/resolve:
 *   post:
 *     summary: Request resolution of a discrepancy (dual control, no financial correction)
 *     description: >
 *       Creates a privileged action request; a second admin must approve it and
 *       it must then be executed via /admin/privileged-actions/{id}/execute.
 *     tags: [Admin]
 *     responses:
 *       202:
 *         description: Approval request created
 */
router.post(
  '/discrepancies/:id/resolve',
  requireJwtAuth,
  requireRoles('admin'),
  // Separate credential from the read-only view: resolution needs the scoped key too.
  requireApiKey('admin:reconciliation'),
  strictRateLimiter,
  validateBody(resolveDiscrepancySchema),
  asyncHandler(async (req, res) => {
    const created = await createPrivilegedRequest({
      actionType: 'reconciliation_resolution',
      payload: {
        discrepancyId: Number(req.params.id),
        reason: req.body.reason,
        evidence: req.body.evidence,
      },
      initiator: req.user!.publicKey,
    });
    res.status(202).json({ success: true, data: created });
  }),
);

const createPrivilegedActionSchema = z.object({
  actionType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
const approvePrivilegedActionSchema = z.object({ payloadHash: z.string().length(64) });

const privilegedId = (value: string | undefined): number => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('Invalid request id');
  return id;
};

/**
 * @swagger
 * /admin/privileged-actions:
 *   post:
 *     summary: Open a dual-control request for a high-impact action
 *     tags: [Admin]
 *     responses:
 *       202:
 *         description: Request created; a different admin must approve it
 */
router.post(
  '/privileged-actions',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  validateBody(createPrivilegedActionSchema),
  asyncHandler(async (req, res) => {
    const created = await createPrivilegedRequest({
      actionType: req.body.actionType,
      payload: req.body.payload,
      initiator: req.user!.publicKey,
    });
    res.status(202).json({ success: true, data: created });
  }),
);

router.get(
  '/privileged-actions/:id',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await getPrivilegedRequest(privilegedId(req.params.id)) });
  }),
);

router.post(
  '/privileged-actions/:id/approve',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  validateBody(approvePrivilegedActionSchema),
  asyncHandler(async (req, res) => {
    await approvePrivilegedRequest(
      privilegedId(req.params.id),
      req.user!.publicKey,
      req.body.payloadHash,
    );
    res.json({ success: true });
  }),
);

router.post(
  '/privileged-actions/:id/revoke',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  asyncHandler(async (req, res) => {
    await revokePrivilegedRequest(privilegedId(req.params.id), req.user!.publicKey);
    res.json({ success: true });
  }),
);

router.post(
  '/privileged-actions/:id/execute',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  asyncHandler(async (req, res) => {
    const result = await executePrivilegedRequest(privilegedId(req.params.id), req.user!.publicKey);
    res.status(result.status === 'executed' ? 200 : 502).json({ success: true, data: result });
  }),
);

export default router;
