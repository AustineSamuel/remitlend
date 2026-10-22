import { Router } from 'express';
import { listMyTransactions } from '../controllers/transactionController.js';
import {
  createDiagnosticBundle,
  getDiagnosticBundle,
  deleteDiagnosticBundle,
} from '../controllers/diagnosticBundleController.js';
import { requireJwtAuth } from '../middleware/jwtAuth.js';
import { requireTransactionAccess } from '../middleware/requireTransactionAccess.js';

const router = Router();

router.get('/me', requireJwtAuth, listMyTransactions);

router.post(
  '/:txHash/diagnostic-bundle',
  requireJwtAuth,
  requireTransactionAccess,
  createDiagnosticBundle,
);

router.get(
  '/:txHash/diagnostic-bundle/:bundleId',
  requireJwtAuth,
  requireTransactionAccess,
  getDiagnosticBundle,
);

router.delete(
  '/:txHash/diagnostic-bundle/:bundleId',
  requireJwtAuth,
  requireTransactionAccess,
  deleteDiagnosticBundle,
);

export default router;