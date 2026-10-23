import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { JobType, JobStatus, MediaAssetStatus } from '@prisma/client';
import { creditLedger } from '../services/credit-ledger.service';
import { ffmpegService } from '../media/ffmpeg.service';
import { proxyQueue, transcodeQueue, aiQueue, exportQueue, getQueueMetrics } from '../queues/job.queue';
import { JobStateMachine } from '../services/job-state-machine';
import { config } from '../config/env';
import { AppError, InvalidStateTransitionError } from '../utils/errors';
import { wsService } from '../services/websocket.service';
import { appLogger } from '../utils/logger';

const logger = appLogger.child('APIController');

export class FrameForgeController {
  // ---------------- AUTH / USER ----------------
  async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user!;
      const account = await creditLedger.getAccount(user.id);
      return res.json({ user, credits: account });
    } catch (e) {
      next(e);
    }
  }

  // ---------------- PROJECTS ----------------
  async createProject(req: Request, res: Response, next: NextFunction) {
    try {
      const { name } = req.body;
      if (!name || typeof name !== 'string') {
        throw new AppError('Project name is required', 400, 'INVALID_INPUT');
      }

      const project = await prisma.project.create({
        data: {
          userId: req.user!.id,
          name: name.trim(),
        },
      });

      return res.status(201).json(project);
    } catch (e) {
      next(e);
    }
  }

  async getProjects(req: Request, res: Response, next: NextFunction) {
    try {
      const projects = await prisma.project.findMany({
        where: { userId: req.user!.id },
        include: {
          mediaAssets: {
            include: { variants: true },
          },
          jobs: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.json(projects);
    } catch (e) {
      next(e);
    }
  }

  async getProjectById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const project = await prisma.project.findFirst({
        where: { id, userId: req.user!.id },
        include: {
          mediaAssets: {
            include: { variants: true },
          },
          jobs: {
            orderBy: { createdAt: 'desc' },
            include: {
              events: {
                where: { eventType: 'AI_ANALYSIS_COMPLETED' },
                take: 1,
              },
            },
          },
        },
      });

      if (!project) {
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }

      return res.json(project);
    } catch (e) {
      next(e);
    }
  }

  // ---------------- MEDIA ----------------
  async uploadMedia(req: Request, res: Response, next: NextFunction) {
    try {
      const { projectId } = req.params;
      const file = req.file;

      if (!file) {
        throw new AppError('No video file provided', 400, 'FILE_MISSING');
      }

      // Verify project ownership
      const project = await prisma.project.findFirst({
        where: { id: projectId, userId: req.user!.id },
      });
      if (!project) {
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }

      // Probe media metadata using FFprobe
      let probeData: any = {};
      try {
        probeData = await ffmpegService.probe(file.path);
      } catch (probeErr: any) {
        logger.warn(`Could not probe uploaded file: ${probeErr.message}`);
      }

      const mediaAsset = await prisma.mediaAsset.create({
        data: {
          projectId,
          originalFilename: file.originalname,
          storageKey: file.path,
          mimeType: file.mimetype,
          sizeBytes: BigInt(file.size),
          durationSeconds: probeData.durationSeconds || null,
          width: probeData.width || null,
          height: probeData.height || null,
          codec: probeData.codec || null,
          bitrate: probeData.bitrate || null,
          status: MediaAssetStatus.READY,
        },
      });

      return res.status(201).json({
        ...mediaAsset,
        sizeBytes: mediaAsset.sizeBytes.toString(),
      });
    } catch (e) {
      next(e);
    }
  }

  async getMediaById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const media = await prisma.mediaAsset.findUnique({
        where: { id },
        include: { variants: true, project: true },
      });

      if (!media || media.project.userId !== req.user!.id) {
        throw new AppError('Media asset not found', 404, 'NOT_FOUND');
      }

      return res.json({
        ...media,
        sizeBytes: media.sizeBytes.toString(),
        variants: media.variants.map((v) => ({
          ...v,
          sizeBytes: v.sizeBytes ? v.sizeBytes.toString() : null,
        })),
      });
    } catch (e) {
      next(e);
    }
  }

  // ---------------- JOBS / OPERATIONS ----------------
  async requestProxy(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: mediaAssetId } = req.params;
      const idempotencyKey = (req.headers['idempotency-key'] as string) || req.body.idempotencyKey;

      const media = await prisma.mediaAsset.findUnique({
        where: { id: mediaAssetId },
        include: { project: true },
      });

      if (!media || media.project.userId !== req.user!.id) {
        throw new AppError('Media asset not found', 404, 'NOT_FOUND');
      }

      // Check database-backed idempotency
      if (idempotencyKey) {
        const existingJob = await prisma.processingJob.findUnique({
          where: { idempotencyKey },
        });
        if (existingJob) {
          logger.info(`Idempotent hit: Returning existing proxy job ${existingJob.id}`);
          return res.status(200).json(existingJob);
        }
      }

      // 1. Transactionally reserve credits
      const jobCost = config.credits.proxyCost;
      const userPriority = req.body.priority || 5;

      // Create Job entry first
      const job = await prisma.processingJob.create({
        data: {
          userId: req.user!.id,
          projectId: media.projectId,
          mediaAssetId: media.id,
          type: JobType.PROXY_GENERATION,
          status: JobStatus.QUEUED,
          priority: userPriority,
          currentStage: 'QUEUED',
          idempotencyKey: idempotencyKey || undefined,
        },
      });

      await creditLedger.reserveCredits(req.user!.id, job.id, jobCost, idempotencyKey);

      // 2. Dispatch to BullMQ Queue
      await proxyQueue.add(
        `proxy-${job.id}`,
        {
          jobId: job.id,
          userId: req.user!.id,
          projectId: media.projectId,
          mediaAssetId: media.id,
          type: JobType.PROXY_GENERATION,
          inputPath: media.storageKey,
          priority: userPriority,
        },
        { priority: userPriority }
      );

      return res.status(202).json(job);
    } catch (e) {
      next(e);
    }
  }

  async requestAIAnalysis(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: mediaAssetId } = req.params;
      const idempotencyKey = (req.headers['idempotency-key'] as string) || req.body.idempotencyKey;

      const media = await prisma.mediaAsset.findUnique({
        where: { id: mediaAssetId },
        include: { project: true },
      });

      if (!media || media.project.userId !== req.user!.id) {
        throw new AppError('Media asset not found', 404, 'NOT_FOUND');
      }

      if (idempotencyKey) {
        const existingJob = await prisma.processingJob.findUnique({
          where: { idempotencyKey },
        });
        if (existingJob) {
          return res.status(200).json(existingJob);
        }
      }

      const jobCost = config.credits.aiCost;
      const job = await prisma.processingJob.create({
        data: {
          userId: req.user!.id,
          projectId: media.projectId,
          mediaAssetId: media.id,
          type: JobType.AI_ANALYSIS,
          status: JobStatus.QUEUED,
          currentStage: 'QUEUED',
          idempotencyKey: idempotencyKey || undefined,
        },
      });

      await creditLedger.reserveCredits(req.user!.id, job.id, jobCost, idempotencyKey);

      await aiQueue.add(`ai-${job.id}`, {
        jobId: job.id,
        userId: req.user!.id,
        projectId: media.projectId,
        mediaAssetId: media.id,
        type: JobType.AI_ANALYSIS,
        inputPath: media.storageKey,
      });

      return res.status(202).json(job);
    } catch (e) {
      next(e);
    }
  }

  async requestExport(req: Request, res: Response, next: NextFunction) {
    try {
      const { projectId } = req.params;
      const idempotencyKey = (req.headers['idempotency-key'] as string) || req.body.idempotencyKey;
      const { mediaAssetId, quality = '1080p', fps = 30 } = req.body;

      const project = await prisma.project.findFirst({
        where: { id: projectId, userId: req.user!.id },
      });
      if (!project) {
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }

      let sourceAssetId = mediaAssetId;
      if (!sourceAssetId) {
        const firstMedia = await prisma.mediaAsset.findFirst({ where: { projectId } });
        if (!firstMedia) {
          throw new AppError('No media asset in project to export', 400, 'MEDIA_REQUIRED');
        }
        sourceAssetId = firstMedia.id;
      }

      const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: sourceAssetId } });

      if (idempotencyKey) {
        const existingJob = await prisma.processingJob.findUnique({
          where: { idempotencyKey },
        });
        if (existingJob) {
          return res.status(200).json(existingJob);
        }
      }

      const jobCost = quality === '4k' ? config.credits.hqExportCost : config.credits.standardExportCost;

      const job = await prisma.processingJob.create({
        data: {
          userId: req.user!.id,
          projectId,
          mediaAssetId: media.id,
          type: JobType.EXPORT,
          status: JobStatus.QUEUED,
          currentStage: 'QUEUED',
          idempotencyKey: idempotencyKey || undefined,
        },
      });

      await creditLedger.reserveCredits(req.user!.id, job.id, jobCost, idempotencyKey);

      await exportQueue.add(`export-${job.id}`, {
        jobId: job.id,
        userId: req.user!.id,
        projectId,
        mediaAssetId: media.id,
        type: JobType.EXPORT,
        inputPath: media.storageKey,
        options: { quality, fps },
      });

      return res.status(202).json(job);
    } catch (e) {
      next(e);
    }
  }

  async getJobById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const job = await prisma.processingJob.findFirst({
        where: { id, userId: req.user!.id },
        include: {
          events: { orderBy: { createdAt: 'desc' } },
          usageRecord: true,
          creditTransactions: true,
        },
      });

      if (!job) {
        throw new AppError('Job not found', 404, 'NOT_FOUND');
      }

      return res.json({
        ...job,
        usageRecord: job.usageRecord
          ? {
              ...job.usageRecord,
              storageBytes: job.usageRecord.storageBytes.toString(),
            }
          : null,
      });
    } catch (e) {
      next(e);
    }
  }

  async cancelJob(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: jobId } = req.params;
      const job = await prisma.processingJob.findFirst({
        where: { id: jobId, userId: req.user!.id },
      });

      if (!job) {
        throw new AppError('Job not found', 404, 'NOT_FOUND');
      }

      if (JobStateMachine.isTerminal(job.status)) {
        throw new AppError(`Cannot cancel a job that is already ${job.status}`, 400, 'JOB_ALREADY_TERMINAL');
      }

      // Check if job is in PROCESSING or QUEUED
      if (job.status === JobStatus.PROCESSING) {
        // Kill FFmpeg process safely
        ffmpegService.cancelJob(jobId);

        await prisma.processingJob.update({
          where: { id: jobId },
          data: {
            status: JobStatus.CANCELLED,
            cancelledAt: new Date(),
            currentStage: 'CANCELLED_BY_USER',
          },
        });
      } else {
        await prisma.processingJob.update({
          where: { id: jobId },
          data: {
            status: JobStatus.CANCELLED,
            cancelledAt: new Date(),
            currentStage: 'CANCELLED_BEFORE_START',
          },
        });
      }

      // Release reserved credits
      let cost = config.credits.proxyCost;
      if (job.type === JobType.AI_ANALYSIS) cost = config.credits.aiCost;
      if (job.type === JobType.EXPORT) cost = config.credits.standardExportCost;

      await creditLedger.releaseReservedCredits(req.user!.id, jobId, cost);

      wsService.broadcastJobStatus({
        jobId,
        userId: req.user!.id,
        projectId: job.projectId,
        status: JobStatus.CANCELLED,
        stage: 'CANCELLED',
        progress: 0,
        timestamp: new Date().toISOString(),
      });

      return res.json({ success: true, message: 'Job cancelled and credits released' });
    } catch (e) {
      next(e);
    }
  }

  async retryJob(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: jobId } = req.params;
      const job = await prisma.processingJob.findFirst({
        where: { id: jobId, userId: req.user!.id },
      });

      if (!job) {
        throw new AppError('Job not found', 404, 'NOT_FOUND');
      }

      if (job.status !== JobStatus.FAILED) {
        throw new AppError(`Only FAILED jobs can be manually retried. Current status: ${job.status}`, 400, 'INVALID_RETRY_STATE');
      }

      let cost = config.credits.proxyCost;
      if (job.type === JobType.AI_ANALYSIS) cost = config.credits.aiCost;
      if (job.type === JobType.EXPORT) cost = config.credits.standardExportCost;

      // Re-reserve credits for the retried attempt
      await creditLedger.reserveCredits(req.user!.id, jobId, cost);

      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.QUEUED,
          currentStage: 'QUEUED_FOR_RETRY',
          errorCode: null,
          errorMessage: null,
          progress: 0,
        },
      });

      let inputPath = '';
      if (job.mediaAssetId) {
        const asset = await prisma.mediaAsset.findUnique({ where: { id: job.mediaAssetId } });
        inputPath = asset?.storageKey || '';
      }

      const jobPayload = {
        jobId: job.id,
        userId: job.userId,
        projectId: job.projectId,
        mediaAssetId: job.mediaAssetId || undefined,
        type: job.type,
        inputPath,
      };

      if (job.type === JobType.PROXY_GENERATION) {
        await proxyQueue.add(`retry-proxy-${job.id}`, jobPayload);
      } else if (job.type === JobType.TRANSCODE) {
        await transcodeQueue.add(`retry-transcode-${job.id}`, jobPayload);
      } else if (job.type === JobType.AI_ANALYSIS) {
        await aiQueue.add(`retry-ai-${job.id}`, jobPayload);
      } else if (job.type === JobType.EXPORT) {
        await exportQueue.add(`retry-export-${job.id}`, jobPayload);
      }

      return res.json({ success: true, message: 'Job re-queued successfully' });
    } catch (e) {
      next(e);
    }
  }

  // ---------------- USAGE & ACCOUNTING ----------------
  async getUsage(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const records = await prisma.usageRecord.findMany({
        where: { userId },
        include: { job: true },
      });

      const totalJobs = records.length;
      let successfulJobs = 0;
      let failedJobs = 0;
      let cancelledJobs = 0;
      let totalProcessingSeconds = 0;
      let totalEstimatedCost = 0;

      for (const r of records) {
        totalProcessingSeconds += r.processingSeconds;
        totalEstimatedCost += r.estimatedCost;
        if (r.job?.status === JobStatus.COMPLETED) successfulJobs++;
        if (r.job?.status === JobStatus.FAILED) failedJobs++;
        if (r.job?.status === JobStatus.CANCELLED) cancelledJobs++;
      }

      return res.json({
        totalJobs,
        successfulJobs,
        failedJobs,
        cancelledJobs,
        totalProcessingSeconds: Math.round(totalProcessingSeconds * 10) / 10,
        estimatedCost: Math.round(totalEstimatedCost * 100) / 100,
        records: records.map((r) => ({
          ...r,
          storageBytes: r.storageBytes.toString(),
        })),
      });
    } catch (e) {
      next(e);
    }
  }

  async getCredits(req: Request, res: Response, next: NextFunction) {
    try {
      const account = await creditLedger.getAccount(req.user!.id);
      return res.json(account);
    } catch (e) {
      next(e);
    }
  }

  async resetCredits(req: Request, res: Response, next: NextFunction) {
    try {
      const target = req.body.amount !== undefined ? parseInt(String(req.body.amount), 10) : 50;
      const newBalance = await creditLedger.resetCredits(req.user!.id, target);
      return res.json({ success: true, balance: newBalance, message: `Credits reset to ${newBalance}` });
    } catch (e) {
      next(e);
    }
  }

  async getCreditTransactions(req: Request, res: Response, next: NextFunction) {
    try {
      const transactions = await prisma.creditTransaction.findMany({
        where: { userId: req.user!.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return res.json(transactions);
    } catch (e) {
      next(e);
    }
  }

  // ---------------- ADMIN / MONITORING ----------------
  async getFailedJobs(req: Request, res: Response, next: NextFunction) {
    try {
      const failedJobs = await prisma.processingJob.findMany({
        where: { status: JobStatus.FAILED },
        include: { events: true, user: { select: { id: true, email: true, name: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      });
      return res.json(failedJobs);
    } catch (e) {
      next(e);
    }
  }

  async getSystemMetrics(req: Request, res: Response, next: NextFunction) {
    try {
      const queueMetrics = await getQueueMetrics();
      const [totalUsers, totalJobs, activeJobsCount] = await Promise.all([
        prisma.user.count(),
        prisma.processingJob.count(),
        prisma.processingJob.count({ where: { status: JobStatus.PROCESSING } }),
      ]);

      return res.json({
        status: 'HEALTHY',
        totalUsers,
        totalJobs,
        activeJobsCount,
        queues: queueMetrics,
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
      });
    } catch (e) {
      next(e);
    }
  }

  async deleteJob(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: jobId } = req.params;
      const job = await prisma.processingJob.findFirst({
        where: { id: jobId, userId: req.user!.id },
      });

      if (!job) {
        throw new AppError('Job not found', 404, 'NOT_FOUND');
      }

      // If job is actively processing, cancel FFmpeg first and release credits if needed
      if (job.status === JobStatus.PROCESSING || job.status === JobStatus.QUEUED) {
        ffmpegService.cancelJob(jobId);
        let cost = config.credits.proxyCost;
        if (job.type === JobType.AI_ANALYSIS) cost = config.credits.aiCost;
        if (job.type === JobType.EXPORT) cost = config.credits.standardExportCost;
        await creditLedger.releaseReservedCredits(req.user!.id, jobId, cost);
      }

      await prisma.processingJob.delete({
        where: { id: jobId },
      });

      return res.json({ success: true, message: `Job ${jobId} deleted successfully` });
    } catch (e) {
      next(e);
    }
  }

  async deleteMedia(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: mediaId } = req.params;
      const media = await prisma.mediaAsset.findUnique({
        where: { id: mediaId },
        include: { project: true },
      });

      if (!media || media.project.userId !== req.user!.id) {
        throw new AppError('Media asset not found', 404, 'NOT_FOUND');
      }

      await prisma.mediaAsset.delete({
        where: { id: mediaId },
      });

      return res.json({ success: true, message: `Media asset deleted successfully` });
    } catch (e) {
      next(e);
    }
  }

  async deleteProject(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: projectId } = req.params;
      const project = await prisma.project.findFirst({
        where: { id: projectId, userId: req.user!.id },
      });

      if (!project) {
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }

      await prisma.project.delete({
        where: { id: projectId },
      });

      return res.json({ success: true, message: `Project deleted successfully` });
    } catch (e) {
      next(e);
    }
  }
}

export const controller = new FrameForgeController();
