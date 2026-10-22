import { Router } from 'express';
import { requireJwtAuth, requireRoles } from '../middleware/jwtAuth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../errors/AppError.js';
import {
  ActiveRetentionLegalHoldError,
  createRetentionLegalHold,
  getRecentRetentionRuns,
  isRetentionDataClass,
  listRetentionLegalHolds,
  RetentionRecordNotFoundError,
  releaseRetentionLegalHold,
} from '../services/dataRetentionService.js';

const router = Router();

router.use(requireJwtAuth, requireRoles('admin'));

router.get(
  '/runs',
  asyncHandler(async (_req, res) => {
    res.json({ runs: await getRecentRetentionRuns() });
  }),
);

router.get(
  '/legal-holds',
  asyncHandler(async (_req, res) => {
    res.json({ holds: await listRetentionLegalHolds() });
  }),
);

router.post(
  '/legal-holds',
  asyncHandler(async (req, res) => {
    const { dataClass, recordId, basis } = req.body as {
      dataClass?: unknown;
      recordId?: unknown;
      basis?: unknown;
    };
    if (
      typeof dataClass !== 'string' ||
      !isRetentionDataClass(dataClass) ||
      typeof recordId !== 'string' ||
      !recordId.trim() ||
      recordId.length > 255 ||
      typeof basis !== 'string' ||
      basis.trim().length < 20 ||
      basis.length > 2000
    ) {
      throw AppError.badRequest('Invalid legal hold data class, record ID, or basis');
    }
    let id: string;
    try {
      id = await createRetentionLegalHold({
        dataClass,
        recordId: recordId.trim(),
        basis,
        actor: req.user!.publicKey,
      });
    } catch (error) {
      if (error instanceof RetentionRecordNotFoundError) {
        throw AppError.notFound(error.message);
      }
      if (error instanceof ActiveRetentionLegalHoldError) {
        throw AppError.conflict(error.message);
      }
      throw error;
    }
    res.status(201).json({ id });
  }),
);

router.post(
  '/legal-holds/:id/release',
  asyncHandler(async (req, res) => {
    const { basis } = req.body as { basis?: unknown };
    if (typeof basis !== 'string' || basis.trim().length < 20 || basis.length > 2000) {
      throw AppError.badRequest('A release basis between 20 and 2000 characters is required');
    }
    const released = await releaseRetentionLegalHold({
      holdId: req.params.id,
      basis,
      actor: req.user!.publicKey,
    });
    if (!released) throw AppError.notFound('Active legal hold not found');
    res.status(204).end();
  }),
);

export default router;
