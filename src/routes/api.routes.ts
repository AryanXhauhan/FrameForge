import { Router } from 'express';
import { controller } from '../controllers/frameforge.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { uploadMiddleware } from '../middlewares/upload.middleware';

const router = Router();

// Apply auth check across FrameForge routes
router.use(authMiddleware);

// User & Profile
router.get('/me', (req, res, next) => controller.getMe(req, res, next));

// Projects
router.post('/projects', (req, res, next) => controller.createProject(req, res, next));
router.get('/projects', (req, res, next) => controller.getProjects(req, res, next));
router.get('/projects/:id', (req, res, next) => controller.getProjectById(req, res, next));
router.delete('/projects/:id', (req, res, next) => controller.deleteProject(req, res, next));

// Media Ingestion
router.post('/projects/:projectId/media', uploadMiddleware.single('file'), (req, res, next) =>
  controller.uploadMedia(req, res, next)
);
router.get('/media/:id', (req, res, next) => controller.getMediaById(req, res, next));
router.delete('/media/:id', (req, res, next) => controller.deleteMedia(req, res, next));

// Media Processing Jobs (BullMQ Queues)
router.post('/media/:id/proxy', (req, res, next) => controller.requestProxy(req, res, next));
router.post('/media/:id/analyze', (req, res, next) => controller.requestAIAnalysis(req, res, next));
router.post('/projects/:projectId/export', (req, res, next) => controller.requestExport(req, res, next));

// Jobs Management
router.get('/jobs/:id', (req, res, next) => controller.getJobById(req, res, next));
router.get('/jobs/:id/download', (req, res, next) => controller.downloadJobResult(req, res, next));
router.post('/jobs/:id/cancel', (req, res, next) => controller.cancelJob(req, res, next));
router.post('/jobs/:id/retry', (req, res, next) => controller.retryJob(req, res, next));
router.delete('/jobs/:id', (req, res, next) => controller.deleteJob(req, res, next));

// Credits & Ledger
router.get('/credits', (req, res, next) => controller.getCredits(req, res, next));
router.post('/credits/reset', (req, res, next) => controller.resetCredits(req, res, next));
router.get('/credits/transactions', (req, res, next) => controller.getCreditTransactions(req, res, next));

// Usage & Cost Accounting
router.get('/usage', (req, res, next) => controller.getUsage(req, res, next));

// Admin & Observability
router.get('/admin/jobs/failed', (req, res, next) => controller.getFailedJobs(req, res, next));
router.get('/metrics', (req, res, next) => controller.getSystemMetrics(req, res, next));

export default router;
