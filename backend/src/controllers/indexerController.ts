import type { Request, Response } from 'express';
import { xdr } from '@stellar/stellar-sdk';
import { query } from '../db/connection.js';
import { EventIndexer, type SorobanRawEvent } from '../services/eventIndexer.js';
import { transferHistoryService } from '../services/transferHistoryService.js';
import {
  SUPPORTED_WEBHOOK_EVENT_TYPES,
  webhookService,
  WebhookService,
  type WebhookEventType,
  WebhookService,
} from '../services/webhookService.js';
import {
  validateWebhookUrl,
  WebhookEgressPolicyError,
} from '../services/webhookEgress.js';
import {
  createCursorPaginatedResponse,
  decodeCursor,
  encodeCursor,
  parseCursorQueryParams,
  parseKeysetParams,
  parseQueryParams,
} from '../utils/pagination.js';
import { parseCappedLimit } from '../utils/queryHelpers.js';
import logger from '../utils/logger.js';
import {
  activateWebhookSigningKey,
  getMaxWebhookKeyOverlapSeconds,
  rollbackWebhookSigningKey,
  rotateWebhookSigningKey,
  WebhookKeyRotationError,
} from '../services/webhookKeyRotationService.js';

import { getStellarRpcUrl } from '../config/stellar.js';

const buildEventFilters = (req: Request, baseParams: unknown[], initialWhereClause: string) => {
  const { status, dateRange, amountRange } = parseQueryParams(req);
  const params = [...baseParams];
  let whereClause = initialWhereClause;

  const appendCondition = (condition: string) => {
    whereClause += whereClause.includes('WHERE') ? ` AND ${condition}` : ` WHERE ${condition}`;
  };

  const requestedStatus =
    status && status !== 'all'
      ? status
      : typeof req.query.eventType === 'string'
        ? req.query.eventType
        : null;

  if (requestedStatus) {
    params.push(requestedStatus);
    appendCondition(`event_type = $${params.length}`);
  }

  if (amountRange) {
    params.push(amountRange.min, amountRange.max);
    appendCondition(`CAST(amount AS NUMERIC) BETWEEN $${params.length - 1} AND $${params.length}`);
  }

  if (dateRange) {
    params.push(dateRange.start.toISOString(), dateRange.end.toISOString());
    appendCondition(`ledger_closed_at BETWEEN $${params.length - 1} AND $${params.length}`);
  }

  return { params, whereClause };
};

type QuarantineEventRow = {
  id: number;
  event_id: string;
  ledger: number;
  tx_hash: string;
  contract_id: string;
  raw_xdr: unknown;
  error_message: string;
  quarantined_at: string;
};

const buildIndexerFromConfig = (): EventIndexer => {
  const contractIds = [
    process.env.LOAN_MANAGER_CONTRACT_ID,
    process.env.LENDING_POOL_CONTRACT_ID,
    process.env.REMITTANCE_NFT_CONTRACT_ID,
    process.env.MULTISIG_GOVERNANCE_CONTRACT_ID,
  ].filter((id): id is string => Boolean(id && id.trim().length > 0));

  if (contractIds.length === 0) {
    throw new Error('At least one indexer contract ID must be configured');
  }

  const rpcUrl = getStellarRpcUrl();
  const batchSize = Number(process.env.INDEXER_BATCH_SIZE ?? 100);

  return new EventIndexer({
    rpcUrl,
    contractConfigs: contractIds.map((contractId) => ({ contractId })),
    pollIntervalMs: 30_000,
    batchSize,
  });
};

const decodeQuarantinedRawEvent = (row: QuarantineEventRow): SorobanRawEvent | null => {
  const raw = row.raw_xdr;
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as {
    id?: unknown;
    topics?: unknown;
    value?: unknown;
    ledger?: unknown;
    ledgerClosedAt?: unknown;
    txHash?: unknown;
    contractId?: unknown;
  };

  if (!Array.isArray(candidate.topics) || typeof candidate.value !== 'string') {
    return null;
  }

  const topics = candidate.topics.filter((topic): topic is string => typeof topic === 'string');

  if (topics.length !== candidate.topics.length) {
    return null;
  }

  try {
    const topicValues = topics.map((topic) => xdr.ScVal.fromXDR(topic, 'base64'));
    const value = xdr.ScVal.fromXDR(candidate.value, 'base64');
    const ledgerClosedAt =
      typeof candidate.ledgerClosedAt === 'string' ? candidate.ledgerClosedAt : row.quarantined_at;

    return {
      id: row.event_id,
      pagingToken: String(row.ledger),
      topic: topicValues,
      value,
      ledger: row.ledger,
      ledgerClosedAt,
      txHash: typeof candidate.txHash === 'string' ? candidate.txHash : row.tx_hash,
      contractId: typeof candidate.contractId === 'string' ? candidate.contractId : row.contract_id,
    };
  } catch (error) {
    logger.withContext().warn('Failed to decode quarantined raw event', {
      quarantineId: row.id,
      eventId: row.event_id,
      error,
    });
    return null;
  }
};

/**
 * Get indexer status
 */
export const getIndexerStatus = async (_req: Request, res: Response) => {
  try {
    const result = await query(
      'SELECT last_indexed_ledger, last_indexed_cursor, updated_at FROM indexer_state ORDER BY id DESC LIMIT 1',
      [],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Indexer state not found',
      });
    }

    const state = result.rows[0];
    const eventCounts = await query(
      `SELECT event_type, COUNT(*) as count
       FROM contract_events
       GROUP BY event_type`,
      [],
    );
    const totalEvents = await query('SELECT COUNT(*) as total FROM contract_events', []);

    return res.json({
      success: true,
      data: {
        lastIndexedLedger: state.last_indexed_ledger,
        lastIndexedCursor: state.last_indexed_cursor,
        lastUpdated: state.updated_at,
        totalEvents: Number.parseInt(totalEvents.rows[0].total, 10),
        eventsByType: eventCounts.rows.reduce(
          (acc, row) => {
            acc[row.event_type] = Number.parseInt(row.count, 10);
            return acc;
          },
          {} as Record<string, number>,
        ),
      },
    });
  } catch (error) {
    logger.withContext().error('Failed to get indexer status', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to get indexer status',
    });
  }
};

/**
 * Get loan events for a specific borrower
 */
export const getBorrowerEvents = async (req: Request, res: Response) => {
  try {
    const borrowerParam = req.params.borrower;
    const borrower = Array.isArray(borrowerParam) ? borrowerParam[0] : borrowerParam;
    if (!borrower) {
      return res.status(400).json({
        success: false,
        message: 'Borrower is required',
      });
    }

    // Parse keyset pagination params
    const snapshotSeq = typeof req.query.snapshot_seq === 'string' ? req.query.snapshot_seq : null;
    const cursorStr = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const limitParam = typeof req.query.limit === 'string' ? req.query.limit : null;

    const {
      snapshotSeq: parsedSnapshotSeq,
      cursor: parsedCursor,
      limit,
    } = parseKeysetParams(snapshotSeq, cursorStr, limitParam);

    // Decode cursor if provided
    let decodedCursor = null;
    if (parsedCursor) {
      decodedCursor = decodeCursor(parsedCursor);
    }

    // Apply additional filters
    const { params: filterParams, whereClause: filterClause } = buildEventFilters(
      req,
      [borrower],
      'WHERE address = $1',
    );

    // Build keyset clause for pagination
    const params = [...filterParams];
    let whereClause = filterClause;

    // Pin snapshot on first request or use provided one
    let actualSnapshotSeq = parsedSnapshotSeq;
    if (actualSnapshotSeq === BigInt(0)) {
      // First page: pin the current max seq
      const maxSeqResult = await query('SELECT MAX(seq) as max_seq FROM contract_events', []);
      actualSnapshotSeq = BigInt(maxSeqResult.rows[0]?.max_seq ?? 0);
    }

    // Add snapshot constraint
    params.push(actualSnapshotSeq.toString());
    const snapshotClause = `seq <= $${params.length}`;
    whereClause += whereClause.includes('WHERE')
      ? ` AND ${snapshotClause}`
      : ` WHERE ${snapshotClause}`;

    // Add keyset constraint
    if (decodedCursor) {
      params.push(decodedCursor.createdAt.toISOString());
      params.push(decodedCursor.createdAt.toISOString());
      params.push(decodedCursor.seq.toString());
      const keysetClause = `(created_at < $${params.length - 2} OR (created_at = $${params.length - 1} AND seq < $${params.length}))`;
      whereClause += ` AND ${keysetClause}`;
    }

    params.push(limit + 1);

    const queryText = `
      SELECT event_id, event_type, loan_id, address, amount,
             ledger, ledger_closed_at, tx_hash, created_at, id, seq
      FROM contract_events
      ${whereClause}
      ORDER BY created_at DESC, seq DESC
      LIMIT $${params.length}
    `;

    logger.debug('getBorrowerEvents keyset query', {
      queryText,
      queryParams: params,
    });

    const result = await query(queryText, params);
    const hasNext = result.rows.length > limit;
    const events = hasNext ? result.rows.slice(0, limit) : result.rows;

    let nextCursor: string | null = null;
    if (hasNext && events.length > 0) {
      const lastEvent = events[events.length - 1];
      nextCursor = encodeCursor(new Date(lastEvent.created_at), BigInt(lastEvent.seq));
    }

    // Count total at snapshot for stable pagination
    const countParams = [...filterParams];
    countParams.push(actualSnapshotSeq.toString());
    const countWhereClause =
      filterClause +
      (filterClause.includes('WHERE')
        ? ` AND seq <= $${countParams.length}`
        : ` WHERE seq <= $${countParams.length}`);

    const totalResult = await query(
      `SELECT COUNT(*) as count FROM contract_events ${countWhereClause}`,
      countParams,
    );
    const totalAtSnapshot = Number.parseInt(totalResult.rows[0].count, 10);

    return res.json({
      success: true,
      data: {
        address: borrower,
        items: events,
      },
      page: {
        next_cursor: nextCursor,
        snapshot_seq: actualSnapshotSeq.toString(),
        total_at_snapshot: totalAtSnapshot,
        limit,
      },
    });
  } catch (error) {
    logger.withContext().error('Failed to get borrower events', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to get borrower events',
    });
  }
};

/**
 * Get RemittanceNFT transfer history (incoming and outgoing) for a wallet
 */
export const getNftTransferHistory = async (req: Request, res: Response) => {
  try {
    const walletParam = req.params.wallet;
    const wallet = Array.isArray(walletParam) ? walletParam[0] : walletParam;
    if (!wallet) {
      return res.status(400).json({
        success: false,
        message: 'Wallet is required',
      });
    }

    const limit = parseCappedLimit(req);
    const offsetParam = Number(req.query.offset);
    const offset = Number.isInteger(offsetParam) && offsetParam > 0 ? offsetParam : 0;

    const transfers = await transferHistoryService.getTransfersForAddress(wallet, {
      limit,
      offset,
    });

    return res.json({
      success: true,
      data: {
        address: wallet,
        items: transfers,
      },
      page: {
        limit,
        offset,
      },
    });
  } catch (error) {
    logger.withContext().error('Failed to get NFT transfer history', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to get NFT transfer history',
    });
  }
};

/**
 * Get events for a specific loan
 */
export const getLoanEvents = async (req: Request, res: Response) => {
  try {
    const loanIdParam = req.params.loanId;
    const loanId = Array.isArray(loanIdParam) ? loanIdParam[0] : loanIdParam;
    const snapshotSeq = typeof req.query.snapshot_seq === 'string' ? req.query.snapshot_seq : null;
    const cursorStr = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const limitParam = typeof req.query.limit === 'string' ? req.query.limit : null;

    if (!loanId) {
      return res.status(400).json({
        success: false,
        message: 'Loan ID is required',
      });
    }

    const {
      snapshotSeq: parsedSnapshotSeq,
      cursor: parsedCursor,
      limit,
    } = parseKeysetParams(snapshotSeq, cursorStr, limitParam);

    // Decode cursor if provided
    let decodedCursor = null;
    if (parsedCursor) {
      decodedCursor = decodeCursor(parsedCursor);
    }

    // Apply additional filters
    const { params: filterParams, whereClause: filterClause } = buildEventFilters(
      req,
      [loanId],
      'WHERE loan_id = $1',
    );

    // Build keyset clause for pagination
    const params = [...filterParams];
    let whereClause = filterClause;

    // Pin snapshot on first request or use provided one
    let actualSnapshotSeq = parsedSnapshotSeq;
    if (actualSnapshotSeq === BigInt(0)) {
      // First page: pin the current max seq
      const maxSeqResult = await query('SELECT MAX(seq) as max_seq FROM contract_events', []);
      actualSnapshotSeq = BigInt(maxSeqResult.rows[0]?.max_seq ?? 0);
    }

    // Add snapshot constraint
    params.push(actualSnapshotSeq.toString());
    const snapshotClause = `seq <= $${params.length}`;
    whereClause += whereClause.includes('WHERE')
      ? ` AND ${snapshotClause}`
      : ` WHERE ${snapshotClause}`;

    // Add keyset constraint
    if (decodedCursor) {
      params.push(decodedCursor.createdAt.toISOString());
      params.push(decodedCursor.createdAt.toISOString());
      params.push(decodedCursor.seq.toString());
      const keysetClause = `(created_at < $${params.length - 2} OR (created_at = $${params.length - 1} AND seq < $${params.length}))`;
      whereClause += ` AND ${keysetClause}`;
    }

    params.push(limit + 1);

    const queryText = `
      SELECT event_id, event_type, loan_id, address, amount,
             ledger, ledger_closed_at, tx_hash, created_at, id, seq
      FROM contract_events
      ${whereClause}
      ORDER BY created_at DESC, seq DESC
      LIMIT $${params.length}
    `;

    const result = await query(queryText, params);
    const hasNext = result.rows.length > limit;
    const events = hasNext ? result.rows.slice(0, limit) : result.rows;

    let nextCursor: string | null = null;
    if (hasNext && events.length > 0) {
      const lastEvent = events[events.length - 1];
      nextCursor = encodeCursor(new Date(lastEvent.created_at), BigInt(lastEvent.seq));
    }

    // Count total at snapshot for stable pagination
    const countParams = [...filterParams];
    countParams.push(actualSnapshotSeq.toString());
    const countWhereClause =
      filterClause +
      (filterClause.includes('WHERE')
        ? ` AND seq <= $${countParams.length}`
        : ` WHERE seq <= $${countParams.length}`);

    const totalResult = await query(
      `SELECT COUNT(*) as count FROM contract_events ${countWhereClause}`,
      countParams,
    );
    const totalAtSnapshot = Number.parseInt(totalResult.rows[0].count, 10);

    return res.json({
      success: true,
      data: {
        loanId: Number.parseInt(loanId, 10),
        items: events,
      },
      page: {
        next_cursor: nextCursor,
        snapshot_seq: actualSnapshotSeq.toString(),
        total_at_snapshot: totalAtSnapshot,
        limit,
      },
    });
  } catch (error) {
    logger.withContext().error('Failed to get loan events', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to get loan events',
    });
  }
};

/**
 * Get recent events
 */
export const getRecentEvents = async (req: Request, res: Response) => {
  try {
    const snapshotSeq = typeof req.query.snapshot_seq === 'string' ? req.query.snapshot_seq : null;
    const cursorStr = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const limitParam = typeof req.query.limit === 'string' ? req.query.limit : null;

    const {
      snapshotSeq: parsedSnapshotSeq,
      cursor: parsedCursor,
      limit,
    } = parseKeysetParams(snapshotSeq, cursorStr, limitParam);

    // Decode cursor if provided
    let decodedCursor = null;
    if (parsedCursor) {
      decodedCursor = decodeCursor(parsedCursor);
    }

    // Apply additional filters
    const { params: filterParams, whereClause: filterClause } = buildEventFilters(req, [], '');

    // Build keyset clause for pagination
    const params = [...filterParams];
    let whereClause = filterClause;

    // Pin snapshot on first request or use provided one
    let actualSnapshotSeq = parsedSnapshotSeq;
    if (actualSnapshotSeq === BigInt(0)) {
      // First page: pin the current max seq
      const maxSeqResult = await query('SELECT MAX(seq) as max_seq FROM contract_events', []);
      actualSnapshotSeq = BigInt(maxSeqResult.rows[0]?.max_seq ?? 0);
    }

    // Add snapshot constraint
    params.push(actualSnapshotSeq.toString());
    const snapshotClause = `seq <= $${params.length}`;
    whereClause += whereClause.includes('WHERE')
      ? ` AND ${snapshotClause}`
      : ` WHERE ${snapshotClause}`;

    // Add keyset constraint
    if (decodedCursor) {
      params.push(decodedCursor.createdAt.toISOString());
      params.push(decodedCursor.createdAt.toISOString());
      params.push(decodedCursor.seq.toString());
      const keysetClause = `(created_at < $${params.length - 2} OR (created_at = $${params.length - 1} AND seq < $${params.length}))`;
      whereClause += ` AND ${keysetClause}`;
    }

    params.push(limit + 1);

    const queryText = `
      SELECT event_id, event_type, loan_id, address, amount,
             ledger, ledger_closed_at, tx_hash, created_at, id, seq
      FROM contract_events
      ${whereClause}
      ORDER BY created_at DESC, seq DESC
      LIMIT $${params.length}
    `;

    const result = await query(queryText, params);
    const hasNext = result.rows.length > limit;
    const events = hasNext ? result.rows.slice(0, limit) : result.rows;

    let nextCursor: string | null = null;
    if (hasNext && events.length > 0) {
      const lastEvent = events[events.length - 1];
      nextCursor = encodeCursor(new Date(lastEvent.created_at), BigInt(lastEvent.seq));
    }

    // Count total at snapshot for stable pagination
    const countParams = [...filterParams];
    countParams.push(actualSnapshotSeq.toString());
    const countWhereClause =
      filterClause +
      (filterClause.includes('WHERE')
        ? ` AND seq <= $${countParams.length}`
        : ` WHERE seq <= $${countParams.length}`);

    const totalResult = await query(
      `SELECT COUNT(*) as count FROM contract_events ${countWhereClause}`,
      countParams,
    );
    const totalAtSnapshot = Number.parseInt(totalResult.rows[0].count, 10);

    res.json({
      success: true,
      data: {
        items: events,
      },
      page: {
        next_cursor: nextCursor,
        snapshot_seq: actualSnapshotSeq.toString(),
        total_at_snapshot: totalAtSnapshot,
        limit,
      },
    });
  } catch (error) {
    logger.withContext().error('Failed to get recent events', { error });
    res.status(500).json({
      success: false,
      message: 'Failed to get recent events',
    });
  }
};

export const listWebhookSubscriptions = async (req: Request, res: Response) => {
  try {
    const ownerPublicKey = req.user?.publicKey;
    if (!ownerPublicKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const subscriptions = await webhookService.listSubscriptions(ownerPublicKey);

    res.json({
      success: true,
      data: {
        subscriptions,
      },
    });
  } catch (error) {
    logger.withContext().error('Failed to list webhook subscriptions', { error });
    res.status(500).json({
      success: false,
      message: 'Failed to list webhook subscriptions',
    });
  }
};

export const createWebhookSubscription = async (req: Request, res: Response) => {
  try {
    const ownerPublicKey = req.user?.publicKey;
    if (!ownerPublicKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const { callbackUrl, eventTypes, secret } = req.body as {
      callbackUrl?: string;
      eventTypes?: string[];
      secret?: string;
    };

    if (typeof callbackUrl !== 'string' || callbackUrl.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'callbackUrl must be a non-empty string',
      });
    }

    try {
      await validateWebhookUrl(callbackUrl);
    } catch (error) {
      if (!(error instanceof WebhookEgressPolicyError)) throw error;
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    const normalizedEventTypes = Array.isArray(eventTypes)
      ? eventTypes.filter((eventType): eventType is WebhookEventType =>
          SUPPORTED_WEBHOOK_EVENT_TYPES.includes(eventType as WebhookEventType),
        )
      : [];

    if (normalizedEventTypes.length === 0) {
      return res.status(400).json({
        success: false,
        message: `eventTypes must include at least one of: ${SUPPORTED_WEBHOOK_EVENT_TYPES.join(', ')}`,
      });
    }

    const registered = await webhookService.registerSubscription(
      ownerPublicKey,
      secret
        ? {
            callbackUrl,
            eventTypes: normalizedEventTypes,
            secret,
          }
        : {
            callbackUrl,
            eventTypes: normalizedEventTypes,
          },
    );

    return res.status(201).json({
      success: true,
      data: {
        subscription: registered.subscription,
        signingKey: registered.signingKey,
      },
    });
  } catch (error) {
    logger.withContext().error('Failed to create webhook subscription', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to create webhook subscription',
    });
  }
};

export const rotateWebhookSubscriptionKey = async (req: Request, res: Response) => {
  try {
    const ownerPublicKey = req.user?.publicKey;
    if (!ownerPublicKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const subscriptionId = Number(req.params.id ?? req.params.subscriptionId);
    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'subscriptionId must be a positive integer',
      });
    }

    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return res.status(400).json({
        success: false,
        message: 'Idempotency-Key header must contain between 8 and 128 characters',
      });
    }

    const body = req.body as { overlapSeconds?: unknown };
    if (
      body.overlapSeconds !== undefined &&
      (!Number.isSafeInteger(body.overlapSeconds) || Number(body.overlapSeconds) < 1)
    ) {
      return res.status(400).json({
        success: false,
        message: 'overlapSeconds must be a positive integer',
      });
    }

    const result = await rotateWebhookSigningKey(
      subscriptionId,
      ownerPublicKey,
      idempotencyKey,
      body.overlapSeconds === undefined
        ? getMaxWebhookKeyOverlapSeconds()
        : Number(body.overlapSeconds),
    );
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      data: {
        signingKey: {
          keyId: result.keyId,
          ...(result.secret ? { secret: result.secret } : {}),
          ...(result.overlapExpiresAt
            ? { overlapExpiresAt: result.overlapExpiresAt.toISOString() }
            : {}),
        },
        replayed: result.replayed,
      },
    });
  } catch (error) {
    if (error instanceof WebhookKeyRotationError) {
      if (error.code === 'not_found') {
        return res.status(404).json({ success: false, message: error.message });
      }
      if (error.code === 'overlap_in_progress') {
        return res.status(409).json({ success: false, message: error.message });
      }
      if (error.code === 'invalid_overlap') {
        return res.status(400).json({ success: false, message: error.message });
      }
      if (error.code === 'not_pending') {
        return res.status(409).json({ success: false, message: error.message });
      }
    }
    logger.withContext().error('Failed to rotate webhook signing key', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to rotate webhook signing key',
    });
  }
};

export const activateWebhookSubscriptionKey = async (req: Request, res: Response) => {
  try {
    const ownerPublicKey = req.user?.publicKey;
    if (!ownerPublicKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const subscriptionId = Number(req.params.id ?? req.params.subscriptionId);
    const { keyId } = req.body as { keyId?: unknown };
    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({ success: false, message: 'subscriptionId must be positive' });
    }
    if (typeof keyId !== 'string') {
      return res.status(400).json({ success: false, message: 'keyId must be a string' });
    }

    const result = await activateWebhookSigningKey(subscriptionId, ownerPublicKey, keyId);
    return res.json({
      success: true,
      data: {
        keyId: result.keyId,
        ...(result.overlapExpiresAt
          ? { overlapExpiresAt: result.overlapExpiresAt.toISOString() }
          : {}),
        replayed: result.replayed,
      },
    });
  } catch (error) {
    if (error instanceof WebhookKeyRotationError) {
      return res
        .status(error.code === 'not_found' ? 404 : 409)
        .json({ success: false, message: error.message });
    }
    logger.withContext().error('Failed to activate webhook signing key', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to activate webhook signing key',
    });
  }
};

export const rollbackWebhookSubscriptionKey = async (req: Request, res: Response) => {
  try {
    const ownerPublicKey = req.user?.publicKey;
    if (!ownerPublicKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const subscriptionId = Number(req.params.id ?? req.params.subscriptionId);
    const { keyId } = req.body as { keyId?: unknown };
    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({ success: false, message: 'subscriptionId must be positive' });
    }
    if (typeof keyId !== 'string') {
      return res.status(400).json({ success: false, message: 'keyId must be a string' });
    }

    await rollbackWebhookSigningKey(subscriptionId, ownerPublicKey, keyId);
    return res.status(204).send();
  } catch (error) {
    if (error instanceof WebhookKeyRotationError) {
      return res
        .status(error.code === 'not_found' ? 404 : 409)
        .json({ success: false, message: error.message });
    }
    logger.withContext().error('Failed to roll back webhook signing key', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to roll back webhook signing key',
    });
  }
};

export const updateWebhookSubscription = async (req: Request, res: Response) => {
  try {
    const ownerPublicKey = req.user?.publicKey;
    if (!ownerPublicKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const subscriptionId = Number(req.params.id ?? req.params.subscriptionId);
    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'subscriptionId must be a positive integer',
      });
    }

    const { callbackUrl, eventTypes } = req.body as {
      callbackUrl?: string;
      eventTypes?: string[];
    };
    if (callbackUrl === undefined && eventTypes === undefined) {
      return res.status(400).json({
        success: false,
        message: 'At least one of callbackUrl or eventTypes is required',
      });
    }

    if (callbackUrl !== undefined) {
      if (typeof callbackUrl !== 'string' || callbackUrl.length === 0) {
        return res.status(400).json({ success: false, message: 'callbackUrl must be a string' });
      }
      try {
        await validateWebhookUrl(callbackUrl);
      } catch (error) {
        if (!(error instanceof WebhookEgressPolicyError)) throw error;
        return res.status(400).json({ success: false, message: error.message });
      }
    }

    let normalizedEventTypes: WebhookEventType[] | undefined;
    if (eventTypes !== undefined) {
      if (!Array.isArray(eventTypes)) {
        return res.status(400).json({ success: false, message: 'eventTypes must be an array' });
      }
      if (
        eventTypes.length === 0 ||
        eventTypes.some((eventType) => !WebhookService.isSupported(eventType))
      ) {
        return res.status(400).json({
          success: false,
          message: `eventTypes must include only supported event types: ${SUPPORTED_WEBHOOK_EVENT_TYPES.join(', ')}`,
        });
      }
      normalizedEventTypes = eventTypes as WebhookEventType[];
    }

    const subscription = await webhookService.updateSubscription(subscriptionId, ownerPublicKey, {
      ...(callbackUrl !== undefined ? { callbackUrl } : {}),
      ...(normalizedEventTypes !== undefined ? { eventTypes: normalizedEventTypes } : {}),
    });
    if (!subscription) {
      return res.status(404).json({ success: false, message: 'Webhook subscription not found' });
    }

    return res.json({ success: true, data: { subscription } });
  } catch (error) {
    logger.withContext().error('Failed to update webhook subscription', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to update webhook subscription',
    });
  }
};

export const deleteWebhookSubscription = async (req: Request, res: Response) => {
  try {
    const ownerPublicKey = req.user?.publicKey;
    if (!ownerPublicKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const subscriptionId = Number(req.params.id ?? req.params.subscriptionId);

    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'subscriptionId must be a positive integer',
      });
    }

    const deleted = await webhookService.deleteSubscription(subscriptionId, ownerPublicKey);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Webhook subscription not found',
      });
    }

    return res.json({
      success: true,
      message: 'Webhook subscription deleted',
    });
  } catch (error) {
    logger.withContext().error('Failed to delete webhook subscription', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to delete webhook subscription',
    });
  }
};

export const getWebhookSubscriptionAudit = async (req: Request, res: Response) => {
  try {
    const ownerPublicKey = req.user?.publicKey;
    if (!ownerPublicKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const subscriptionId = Number(req.params.id ?? req.params.subscriptionId);
    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'subscriptionId must be a positive integer',
      });
    }

    const history = await webhookService.getSubscriptionAuditHistory(
      subscriptionId,
      ownerPublicKey,
    );
    return res.json({ success: true, data: { history } });
  } catch (error) {
    logger.withContext().error('Failed to get webhook subscription audit history', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to get webhook subscription audit history',
    });
  }
};

export const getWebhookDeliveries = async (req: Request, res: Response) => {
  try {
    const ownerPublicKey = req.user?.publicKey;
    if (!ownerPublicKey) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const subscriptionId = Number(req.params.id ?? req.params.subscriptionId);
    const limit = parseCappedLimit(req, 50);

    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'subscription id must be a positive integer',
      });
    }

    const deliveries = await webhookService.getSubscriptionDeliveries(
      subscriptionId,
      ownerPublicKey,
      limit,
    );

    return res.json({
      success: true,
      data: {
        subscriptionId,
        deliveries,
      },
    });
  } catch (error) {
    logger.withContext().error('Failed to fetch webhook deliveries', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch webhook deliveries',
    });
  }
};

export const listWebhookDeadLetters = async (req: Request, res: Response) => {
  const limit = parseCappedLimit(req, 50);
  const deliveries = await WebhookService.listDeadLetters(limit);
  return res.json({ success: true, data: { deliveries } });
};

export const redriveWebhookDelivery = async (req: Request, res: Response) => {
  const deliveryId = Number(req.params.deliveryId);
  if (!Number.isInteger(deliveryId) || deliveryId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'deliveryId must be a positive integer',
    });
  }

  const actor = req.user?.publicKey ?? 'unknown';
  const result = await WebhookService.redriveDeadLetter(deliveryId, actor);
  if (!result) {
    return res.status(409).json({
      success: false,
      message: 'Delivery is not in the dead-letter state',
    });
  }

  logger.withContext().info('Webhook delivery re-driven', { ...result, actor });
  return res.status(202).json({ success: true, data: result });
};

export const reindexLedgerRange = async (req: Request, res: Response) => {
  try {
    const fromLedger = Number(req.query.fromLedger);
    const toLedger = Number(req.query.toLedger);

    if (!Number.isInteger(fromLedger) || !Number.isInteger(toLedger)) {
      return res.status(400).json({
        success: false,
        message: 'fromLedger and toLedger must be integers',
      });
    }

    if (fromLedger <= 0 || toLedger <= 0 || fromLedger > toLedger) {
      return res.status(400).json({
        success: false,
        message: 'Ledger range is invalid',
      });
    }

    const maxRange = Number(process.env.REINDEX_MAX_RANGE ?? 25000);
    const requestedRange = toLedger - fromLedger + 1;
    if (requestedRange > maxRange) {
      return res.status(400).json({
        success: false,
        message: `Requested range exceeds maximum of ${maxRange} ledgers`,
      });
    }

    let indexer: EventIndexer;
    try {
      indexer = buildIndexerFromConfig();
    } catch (error) {
      logger.withContext().error('Failed to initialize indexer for reindex', { error });
      return res.status(500).json({
        success: false,
        message: 'Indexer is not configured',
      });
    }

    const result = await indexer.reindexRange(fromLedger, toLedger);

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.withContext().error('Failed to reindex ledger range', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to reindex ledger range',
    });
  }
};

export const listQuarantinedEvents = async (req: Request, res: Response) => {
  try {
    const { limit, cursor } = parseCursorQueryParams(req);
    const cursorValue = cursor ? Number.parseInt(cursor, 10) : null;

    if (cursor && (!Number.isInteger(cursorValue) || (cursorValue ?? 0) <= 0)) {
      return res.status(400).json({
        success: false,
        message: 'cursor must be a positive integer',
      });
    }

    const [result, countResult] = await Promise.all([
      query(
        `SELECT id, event_id, ledger, tx_hash, contract_id, raw_xdr, error_message, quarantined_at
         FROM quarantine_events
         WHERE ($1::int IS NULL OR id > $1)
         ORDER BY id ASC
         LIMIT $2`,
        [cursorValue, limit + 1],
      ),
      query('SELECT COUNT(*)::int AS count FROM quarantine_events', []),
    ]);

    const hasNext = result.rows.length > limit;
    const events = hasNext ? result.rows.slice(0, limit) : result.rows;
    const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
    const nextCursor = hasNext && lastEvent ? String(lastEvent.id) : null;

    const response = createCursorPaginatedResponse(
      {
        events,
      },
      Number(countResult.rows[0]?.count ?? 0),
      limit,
      events.length,
      nextCursor,
      Boolean(cursor),
    );

    return res.json(response);
  } catch (error) {
    logger.withContext().error('Failed to list quarantined events', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to list quarantined events',
    });
  }
};

export const reprocessQuarantinedEvents = async (req: Request, res: Response) => {
  try {
    const { ids, limit } = req.body as {
      ids?: unknown;
      limit?: unknown;
    };

    const parsedIds = Array.isArray(ids)
      ? ids.filter((id): id is number => Number.isInteger(id) && id > 0)
      : undefined;

    if (Array.isArray(ids) && (!parsedIds || parsedIds.length !== ids.length)) {
      return res.status(400).json({
        success: false,
        message: 'ids must be an array of positive integers',
      });
    }

    const parsedLimit =
      typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;

    const rowsResult =
      parsedIds && parsedIds.length > 0
        ? await query(
            `SELECT id, event_id, ledger, tx_hash, contract_id, raw_xdr, error_message, quarantined_at
           FROM quarantine_events
           WHERE id = ANY($1::int[])
           ORDER BY id ASC`,
            [parsedIds],
          )
        : await query(
            `SELECT id, event_id, ledger, tx_hash, contract_id, raw_xdr, error_message, quarantined_at
           FROM quarantine_events
           ORDER BY id ASC
           LIMIT $1`,
            [parsedLimit],
          );

    const rows = rowsResult.rows as QuarantineEventRow[];

    let indexer: EventIndexer;
    try {
      indexer = buildIndexerFromConfig();
    } catch (error) {
      logger.withContext().error('Failed to initialize indexer for quarantine reprocess', {
        error,
      });
      return res.status(500).json({
        success: false,
        message: 'Indexer is not configured',
      });
    }

    let deleted = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const rawEvent = decodeQuarantinedRawEvent(row);
        if (!rawEvent || !indexer.isEventParseable(rawEvent)) {
          failed += 1;
          continue;
        }

        await indexer.ingestRawEvents([rawEvent]);
        await query('DELETE FROM quarantine_events WHERE id = $1', [row.id]);
        deleted += 1;
      } catch (error) {
        failed += 1;
        logger.withContext().warn('Failed to reprocess quarantined event', {
          quarantineId: row.id,
          eventId: row.event_id,
          error,
        });
      }
    }

    const remainingResult = await query('SELECT COUNT(*)::int AS count FROM quarantine_events', []);

    return res.json({
      success: true,
      data: {
        requested: rows.length,
        reprocessed: deleted,
        failed,
        remaining: Number(remainingResult.rows[0]?.count ?? 0),
      },
    });
  } catch (error) {
    logger.withContext().error('Failed to reprocess quarantined events', { error });
    return res.status(500).json({
      success: false,
      message: 'Failed to reprocess quarantined events',
    });
  }
};
