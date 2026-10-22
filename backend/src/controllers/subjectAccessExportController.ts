import type { Request, Response } from 'express';
import logger from '../utils/logger.js';
import {
  createSubjectAccessExport,
  downloadSubjectAccessExport,
  getSubjectAccessExport,
  SubjectAccessExportConflictError,
} from '../services/subjectAccessExportService.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function requestSubjectAccessExport(req: Request, res: Response): Promise<void> {
  const subjectPublicKey = req.user?.publicKey;
  if (!subjectPublicKey) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }

  try {
    const job = await createSubjectAccessExport(subjectPublicKey);
    res.status(202).json({
      success: true,
      data: {
        ...job,
        statusUrl: `/user/data-exports/${job.id}`,
        downloadUrl: `/user/data-exports/${job.id}/download`,
      },
    });
  } catch (error) {
    if (error instanceof SubjectAccessExportConflictError) {
      res.status(409).json({ success: false, message: error.message });
      return;
    }
    logger.error('Failed to request subject access export', { error, subjectPublicKey });
    res.status(500).json({ success: false, message: 'Failed to request data export' });
  }
}

export async function getSubjectAccessExportStatus(req: Request, res: Response): Promise<void> {
  const subjectPublicKey = req.user?.publicKey;
  if (!subjectPublicKey) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }
  if (!UUID_PATTERN.test(req.params.id ?? '')) {
    res.status(400).json({ success: false, message: 'Invalid export ID' });
    return;
  }

  try {
    const job = await getSubjectAccessExport(req.params.id, subjectPublicKey);
    if (!job) {
      res.status(404).json({ success: false, message: 'Export not found or expired' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: job });
  } catch (error) {
    logger.error('Failed to get subject access export status', { error, subjectPublicKey });
    res.status(500).json({ success: false, message: 'Failed to get export status' });
  }
}

export async function downloadSubjectAccessExportFile(
  req: Request,
  res: Response,
): Promise<void> {
  const subjectPublicKey = req.user?.publicKey;
  if (!subjectPublicKey) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }
  if (!UUID_PATTERN.test(req.params.id ?? '')) {
    res.status(400).json({ success: false, message: 'Invalid export ID' });
    return;
  }

  try {
    const exportData = await downloadSubjectAccessExport(req.params.id, subjectPublicKey);
    if (!exportData) {
      res.status(404).json({ success: false, message: 'Export not found, incomplete, or expired' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="remitlend-subject-export-${req.params.id}.json"`,
    );
    res.status(200).send(JSON.stringify(exportData));
  } catch (error) {
    logger.error('Failed to download subject access export', { error, subjectPublicKey });
    res.status(500).json({ success: false, message: 'Failed to download export' });
  }
}
