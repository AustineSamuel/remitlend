import { Router } from 'express';
import {
  getIndexerStatus,
  getBorrowerEvents,
  getLoanEvents,
  getNftTransferHistory,
  getRecentEvents,
  listWebhookSubscriptions,
  createWebhookSubscription,
  rotateWebhookSubscriptionKey,
  activateWebhookSubscriptionKey,
  rollbackWebhookSubscriptionKey,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookSubscriptionAudit,
} from '../controllers/indexerController.js';
import { requireApiKey } from '../middleware/auth.js';
import { requireJwtAuth, requireScopes, requireWalletOwnership } from '../middleware/jwtAuth.js';
import { requireLoanBorrowerAccess } from '../middleware/loanAccess.js';
import { strictRateLimiter } from '../middleware/rateLimiter.js';
import { auditLog } from '../middleware/auditLog.js';

const router = Router();

/**
 * @swagger
 * /indexer/status:
 *   get:
 *     summary: Get indexer status
 *     description: Returns the current state of the event indexer including last indexed ledger and event counts
 *     tags: [Indexer]
 *     responses:
 *       200:
 *         description: Indexer status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/IndexerStatusResponse'
 */
router.get('/status', getIndexerStatus);

/**
 * @swagger
 * /indexer/events/borrower/{borrower}:
 *   get:
 *     summary: Get events for a specific borrower
 *     description: >
 *       Returns loan events for the authenticated wallet; `borrower` must match
 *       the JWT Stellar public key.
 *     tags: [Indexer]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: borrower
 *         required: true
 *         schema:
 *           type: string
 *         description: Borrower's Stellar address
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Events retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BorrowerEventsResponse'
 *       401:
 *         description: Missing or invalid Bearer token
 *       403:
 *         description: borrower does not match authenticated wallet
 */
router.get(
  '/events/borrower/:borrower',
  requireJwtAuth,
  requireScopes('read:loans'),
  requireWalletOwnership,
  getBorrowerEvents,
);

/**
 * @swagger
 * /indexer/transfers/nft/{wallet}:
 *   get:
 *     summary: Get RemittanceNFT transfer history for a wallet
 *     description: >
 *       Returns NFT transfers where the wallet was either sender or recipient, newest first.
 *       `wallet` must match the JWT Stellar public key.
 *     tags: [Indexer]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema:
 *           type: string
 *         description: Wallet's Stellar address
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Transfers retrieved successfully
 *       401:
 *         description: Missing or invalid Bearer token
 *       403:
 *         description: wallet does not match authenticated wallet
 */
router.get(
  '/transfers/nft/:wallet',
  requireJwtAuth,
  requireScopes('read:remittances'),
  requireWalletOwnership,
  getNftTransferHistory,
);

/**
 * @swagger
 * /indexer/events/loan/{loanId}:
 *   get:
 *     summary: Get events for a specific loan
 *     description: >
 *       Returns events only if the authenticated wallet is the borrower for that loan.
 *     tags: [Indexer]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: loanId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Loan ID
 *     responses:
 *       200:
 *         description: Events retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoanEventsResponse'
 *       401:
 *         description: Missing or invalid Bearer token
 *       404:
 *         description: Loan not found or not accessible
 */
router.get(
  '/events/loan/:loanId',
  requireJwtAuth,
  requireScopes('read:loans'),
  requireLoanBorrowerAccess,
  getLoanEvents,
);

/**
 * @swagger
 * /indexer/events/recent:
 *   get:
 *     summary: Get recent events
 *     description: >
 *       Internal/admin use: requires an `admin:indexer` scoped `x-api-key`.
 *       Returns the most recent loan events, optionally filtered by event type.
 *     tags: [Indexer]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: eventType
 *         schema:
 *           type: string
 *           enum: [LoanRequested, LoanApproved, LoanRepaid, LoanDefaulted]
 *     responses:
 *       200:
 *         description: Events retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RecentEventsResponse'
 *       401:
 *         description: Missing or invalid API key
 */
router.get('/events/recent', requireApiKey('admin:indexer'), getRecentEvents);

/**
 * @swagger
 * /indexer/webhooks:
 *   get:
 *     summary: List webhook subscriptions
 *     tags: [Indexer]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Webhook subscriptions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WebhookSubscriptionListResponse'
 *       401:
 *         description: Missing or invalid bearer token
 */
router.get('/webhooks', requireJwtAuth, requireScopes('read:webhooks'), listWebhookSubscriptions);

/**
 * @swagger
 * /indexer/webhooks:
 *   post:
 *     summary: Register a webhook subscription
 *     tags: [Indexer]
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
 *                   enum: [LoanRequested, LoanApproved, LoanRepaid, LoanDefaulted]
 *               secret:
 *                 type: string
 *     responses:
 *       201:
 *         description: Webhook subscription created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WebhookSubscriptionResponse'
 *       401:
 *         description: Missing or invalid bearer token
 */
router.post(
  '/webhooks',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  createWebhookSubscription,
);

/**
 * @swagger
 * /indexer/webhooks/{subscriptionId}/rotate-key:
 *   post:
 *     summary: Rotate an owned webhook signing key
 *     description: >
 *       Creates a new current signing key while retaining the previous key
 *       until the receiver confirms the new key or the bounded overlap expires.
 *       The secret is returned only in the first successful response.
 *     tags: [Indexer]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: subscriptionId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 8
 *           maxLength: 128
 *     responses:
 *       201:
 *         description: Signing key rotated; new secret is disclosed once
 *       404:
 *         description: Subscription not found or not owned by the caller
 *       409:
 *         description: A previous rotation is still in its overlap window
 */
router.post(
  '/webhooks/:subscriptionId/rotate-key',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  rotateWebhookSubscriptionKey,
);

router.post(
  '/webhooks/:subscriptionId/activate-key',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  activateWebhookSubscriptionKey,
);

router.post(
  '/webhooks/:subscriptionId/rollback-key',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  rollbackWebhookSubscriptionKey,
);

/**
 * @swagger
 * /indexer/webhooks/{subscriptionId}:
 *   put:
 *     summary: Update an owned webhook subscription
 *     tags: [Indexer]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: subscriptionId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Subscription updated
 *       404:
 *         description: Subscription not found or not owned by the caller
 */
router.put(
  '/webhooks/:subscriptionId',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  updateWebhookSubscription,
);

router.get(
  '/webhooks/:subscriptionId/audit',
  requireJwtAuth,
  requireScopes('read:webhooks'),
  getWebhookSubscriptionAudit,
);

/**
 * @swagger
 * /indexer/webhooks/{subscriptionId}:
 *   delete:
 *     summary: Delete a webhook subscription
 *     tags: [Indexer]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: subscriptionId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Webhook subscription deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessMessageResponse'
 *       401:
 *         description: Missing or invalid bearer token
 */
router.delete(
  '/webhooks/:subscriptionId',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  deleteWebhookSubscription,
);

export default router;
