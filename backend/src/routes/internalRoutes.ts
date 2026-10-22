import express from 'express';
import { internalRequestSigningMiddleware } from '../middleware/internalRequestSigning.js';
import { notificationService } from '../services/notificationService.js';
import logger from '../utils/logger.js';

const router = express.Router();

router.use(internalRequestSigningMiddleware);

router.post('/admin/emergency-pause', (req, res) => {
  res.json({ message: 'Contract pause initiated (internal only)' });
});

router.post('/admin/contract-state-update', (req, res) => {
  res.json({ message: 'Contract state updated (internal only)' });
});

router.post('/notification-receipts', async (req, res) => {
  const { provider, providerMessageId, status, errorCode } = req.body as {
    provider?: unknown;
    providerMessageId?: unknown;
    status?: unknown;
    errorCode?: unknown;
  };
  if (
    (provider !== 'sendgrid' && provider !== 'twilio') ||
    typeof providerMessageId !== 'string' ||
    providerMessageId.length === 0 ||
    providerMessageId.length > 255 ||
    (status !== 'delivered' &&
      status !== 'retryable_failure' &&
      status !== 'permanent_failure') ||
    (errorCode !== undefined && typeof errorCode !== 'string')
  ) {
    res.status(400).json({ success: false, message: 'Invalid notification receipt' });
    return;
  }

  try {
    const matched = await notificationService.recordProviderReceipt({
      provider,
      providerMessageId,
      status,
      ...(typeof errorCode === 'string' ? { errorCode: errorCode.slice(0, 64) } : {}),
    });
    if (!matched) {
      res.status(404).json({ success: false, message: 'Provider message not found' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    logger.error('Failed to record notification delivery receipt', { error });
    res.status(500).json({ success: false, message: 'Failed to record delivery receipt' });
  }
});

export default router;
