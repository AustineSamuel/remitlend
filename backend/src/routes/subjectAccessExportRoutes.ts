import { Router } from 'express';
import {
  downloadSubjectAccessExportFile,
  getSubjectAccessExportStatus,
  requestSubjectAccessExport,
} from '../controllers/subjectAccessExportController.js';
import { requireJwtAuth } from '../middleware/jwtAuth.js';

const router = Router();

router.post('/', requireJwtAuth, requestSubjectAccessExport);
router.get('/:id', requireJwtAuth, getSubjectAccessExportStatus);
router.get('/:id/download', requireJwtAuth, downloadSubjectAccessExportFile);

export default router;
