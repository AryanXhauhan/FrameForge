import { Job, Worker, WorkerOptions } from 'bullmq';
import { JobStatus, MediaVariantType } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import { prisma, redisConnection } from '../config/database';
import { QUEUE_NAMES, JobData } from '../queues/job.queue';
import { ffmpegService } from '../media/ffmpeg.service';
import { getAIProvider } from '../ai/ai-provider.service';
import { creditLedger } from '../services/credit-ledger.service';
import { wsService } from '../services/websocket.service';
import { JobStateMachine } from '../services/job-state-machine';
import { classifyError, JobCancelledError } from '../utils/errors';
import { appLogger } from '../utils/logger';
import { config } from '../config/env';

export class BaseWorker {
  protected logger = appLogger.child('Worker');

  protected async updateJobProgress(
    jobId: string,
    userId: string,
    projectId: string,
    stage: string,
    progress: number
  ) {
    // 1. Check if job was cancelled and retrieve startedAt for precise ETA computation
    const current = await prisma.processingJob.findUnique({
      where: { id: jobId },
      select: { status: true, startedAt: true },
    });

    if (current?.status === JobStatus.CANCELLED || current?.status === JobStatus.CANCELLING) {
      throw new JobCancelledError(jobId);
    }

    // Compute accurate elapsed and ETA seconds
    let elapsedSeconds = 0;
    let etaSeconds: number | undefined;

    if (current?.startedAt) {
      elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(current.startedAt).getTime()) / 1000));
      if (progress > 3 && progress < 100) {
        // Linear velocity ETA projection with clamping
        const totalEstimated = (elapsedSeconds / progress) * 100;
        etaSeconds = Math.max(1, Math.round(totalEstimated - elapsedSeconds));
      } else if (progress >= 100) {
        etaSeconds = 0;
      }
    }

    // 2. Update DB job state
    await prisma.processingJob.update({
      where: { id: jobId },
      data: {
        currentStage: stage,
        progress,
        updatedAt: new Date(),
      },
    });

    // 3. Emit real-time WebSocket event with honest ETA and elapsed timers
    wsService.broadcastJobProgress({
      jobId,
      userId,
      projectId,
      status: JobStatus.PROCESSING,
      stage,
      progress,
      etaSeconds,
      elapsedSeconds,
      timestamp: new Date().toISOString(),
    });
  }

  protected async recordUsage(
    userId: string,
    jobId: string,
    processingSec: number,
    storageBytes: number = 0,
    aiTokens: { input: number; output: number } = { input: 0, output: 0 },
    estimatedCost: number = 0.05
  ) {
    try {
      await prisma.usageRecord.upsert({
        where: { jobId },
        create: {
          userId,
          jobId,
          processingSeconds: processingSec,
          cpuSeconds: Math.round(processingSec * 1.5 * 10) / 10,
          storageBytes: BigInt(storageBytes),
          aiInputTokens: aiTokens.input,
          aiOutputTokens: aiTokens.output,
          estimatedCost,
        },
        update: {
          processingSeconds: processingSec,
          storageBytes: BigInt(storageBytes),
          aiInputTokens: aiTokens.input,
          aiOutputTokens: aiTokens.output,
          estimatedCost,
        },
      });
    } catch (e: any) {
      this.logger.error('Failed to record usage record', e, { jobId, userId });
    }
  }
}

export function createProxyWorker(): Worker<JobData> {
  const logger = appLogger.child('ProxyWorker');
  const base = new BaseWorker();

  const worker = new Worker<JobData>(
    QUEUE_NAMES.PROXY,
    async (job: Job<JobData>) => {
      const startTime = Date.now();
      const { jobId, userId, projectId, mediaAssetId, inputPath } = job.data;
      logger.info(`Starting proxy generation for job ${jobId}`, { jobId, userId });

      // State check & transition to PROCESSING
      const dbJob = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
      JobStateMachine.validateTransition(dbJob.status, JobStatus.PROCESSING);

      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.PROCESSING,
          startedAt: new Date(),
          attempts: job.attemptsMade + 1,
        },
      });

      await prisma.jobEvent.create({
        data: {
          jobId,
          eventType: 'JOB_STARTED',
          progress: 0,
          metadata: { queue: QUEUE_NAMES.PROXY, attempt: job.attemptsMade + 1 },
        },
      });

      const outputFileName = `proxy-${path.basename(inputPath, path.extname(inputPath))}-360p.mp4`;
      const outputPath = path.join(config.storage.outputDir, outputFileName);

      // Execute FFmpeg proxy transcode with honest progress
      await ffmpegService.generateProxy(
        jobId,
        inputPath,
        outputPath,
        { width: 640, height: 360, bitrate: '800k' },
        (stage, percent) => {
          base['updateJobProgress'](jobId, userId, projectId, stage, percent);
        }
      );

      // Inspect output file
      const stat = fs.statSync(outputPath);
      const probe = await ffmpegService.probe(outputPath);

      if (mediaAssetId) {
        await prisma.mediaVariant.create({
          data: {
            mediaAssetId,
            type: MediaVariantType.PROXIED_360P,
            storageKey: outputPath,
            width: probe.width,
            height: probe.height,
            codec: probe.codec,
            bitrate: probe.bitrate,
            sizeBytes: BigInt(stat.size),
            status: 'READY',
          },
        });
      }

      // Mark Job Completed & Settle Credits
      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.COMPLETED,
          progress: 100,
          currentStage: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      await creditLedger.consumeReservedCredits(userId, jobId, config.credits.proxyCost);

      const durationSec = (Date.now() - startTime) / 1000;
      await base['recordUsage'](userId, jobId, durationSec, stat.size, { input: 0, output: 0 }, 0.02);

      wsService.broadcastJobProgress({
        jobId,
        userId,
        projectId,
        status: JobStatus.COMPLETED,
        stage: 'COMPLETED',
        progress: 100,
        timestamp: new Date().toISOString(),
      });

      return { outputPath, size: stat.size };
    },
    {
      connection: redisConnection,
      concurrency: 2,
    }
  );

  setupWorkerErrorHandling(worker, QUEUE_NAMES.PROXY, config.credits.proxyCost);
  return worker;
}

export function createTranscodeWorker(): Worker<JobData> {
  const logger = appLogger.child('TranscodeWorker');
  const base = new BaseWorker();

  const worker = new Worker<JobData>(
    QUEUE_NAMES.TRANSCODE,
    async (job: Job<JobData>) => {
      const startTime = Date.now();
      const { jobId, userId, projectId, mediaAssetId, inputPath } = job.data;
      logger.info(`Starting transcode normalization for job ${jobId}`, { jobId });

      const dbJob = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
      JobStateMachine.validateTransition(dbJob.status, JobStatus.PROCESSING);

      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.PROCESSING,
          startedAt: new Date(),
          attempts: job.attemptsMade + 1,
        },
      });

      const outputFileName = `normalized-${path.basename(inputPath, path.extname(inputPath))}-1080p.mp4`;
      const outputPath = path.join(config.storage.outputDir, outputFileName);

      await ffmpegService.normalizeVideo(jobId, inputPath, outputPath, (stage, percent) => {
        base['updateJobProgress'](jobId, userId, projectId, stage, percent);
      });

      const stat = fs.statSync(outputPath);
      const probe = await ffmpegService.probe(outputPath);

      if (mediaAssetId) {
        await prisma.mediaVariant.create({
          data: {
            mediaAssetId,
            type: MediaVariantType.NORMALIZED_1080P,
            storageKey: outputPath,
            width: probe.width,
            height: probe.height,
            codec: probe.codec,
            bitrate: probe.bitrate,
            sizeBytes: BigInt(stat.size),
            status: 'READY',
          },
        });
      }

      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.COMPLETED,
          progress: 100,
          currentStage: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      await creditLedger.consumeReservedCredits(userId, jobId, config.credits.proxyCost);
      const durationSec = (Date.now() - startTime) / 1000;
      await base['recordUsage'](userId, jobId, durationSec, stat.size, { input: 0, output: 0 }, 0.04);

      wsService.broadcastJobProgress({
        jobId,
        userId,
        projectId,
        status: JobStatus.COMPLETED,
        stage: 'COMPLETED',
        progress: 100,
        timestamp: new Date().toISOString(),
      });

      return { outputPath };
    },
    {
      connection: redisConnection,
      concurrency: 2,
    }
  );

  setupWorkerErrorHandling(worker, QUEUE_NAMES.TRANSCODE, config.credits.proxyCost);
  return worker;
}

export function createAIWorker(): Worker<JobData> {
  const logger = appLogger.child('AIWorker');
  const base = new BaseWorker();

  const worker = new Worker<JobData>(
    QUEUE_NAMES.AI,
    async (job: Job<JobData>) => {
      const startTime = Date.now();
      const { jobId, userId, projectId, inputPath } = job.data;
      logger.info(`Starting AI analysis for job ${jobId}`, { jobId });

      const dbJob = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
      JobStateMachine.validateTransition(dbJob.status, JobStatus.PROCESSING);

      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.PROCESSING,
          startedAt: new Date(),
          attempts: job.attemptsMade + 1,
        },
      });

      await base['updateJobProgress'](jobId, userId, projectId, 'INSPECTING_MEDIA_STREAM', 15);

      const probe = await ffmpegService.probe(inputPath);

      await base['updateJobProgress'](jobId, userId, projectId, 'AI_INFERENCE_SCENE_DETECTION', 45);

      const aiProvider = getAIProvider(config.ai.provider);
      const analysis = await aiProvider.analyzeVideo(inputPath, {
        duration: probe.durationSeconds,
        filename: path.basename(inputPath),
      });

      await base['updateJobProgress'](jobId, userId, projectId, 'GENERATING_STRUCTURAL_INSIGHTS', 85);

      // Store analysis results in JobEvent
      await prisma.jobEvent.create({
        data: {
          jobId,
          eventType: 'AI_ANALYSIS_COMPLETED',
          progress: 100,
          metadata: analysis as any,
        },
      });

      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.COMPLETED,
          progress: 100,
          currentStage: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      await creditLedger.consumeReservedCredits(userId, jobId, config.credits.aiCost);

      const durationSec = (Date.now() - startTime) / 1000;
      await base['recordUsage'](userId, jobId, durationSec, 0, analysis.tokensUsed, 0.08);

      wsService.broadcastJobProgress({
        jobId,
        userId,
        projectId,
        status: JobStatus.COMPLETED,
        stage: 'COMPLETED',
        progress: 100,
        metadata: analysis,
        timestamp: new Date().toISOString(),
      });

      return analysis;
    },
    {
      connection: redisConnection,
      concurrency: 3,
    }
  );

  setupWorkerErrorHandling(worker, QUEUE_NAMES.AI, config.credits.aiCost);
  return worker;
}

export function createExportWorker(): Worker<JobData> {
  const logger = appLogger.child('ExportWorker');
  const base = new BaseWorker();

  const worker = new Worker<JobData>(
    QUEUE_NAMES.EXPORT,
    async (job: Job<JobData>) => {
      const startTime = Date.now();
      const { jobId, userId, projectId, inputPath, options } = job.data;
      const creditCost = options?.quality === '4k' ? config.credits.hqExportCost : config.credits.standardExportCost;

      logger.info(`Starting video export for job ${jobId}`, { jobId, options });

      const dbJob = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
      JobStateMachine.validateTransition(dbJob.status, JobStatus.PROCESSING);

      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.PROCESSING,
          startedAt: new Date(),
          attempts: job.attemptsMade + 1,
        },
      });

      // Parallel sub-task demonstration: Export video + generate poster thumbnail
      const outputFileName = `export-${jobId}-${options?.quality || '1080p'}.mp4`;
      const outputPath = path.join(config.storage.outputDir, outputFileName);
      const thumbnailFolder = path.join(config.storage.outputDir, `thumbs-${jobId}`);

      // 1. Run parallel thumbnail & audio extraction tasks
      await Promise.all([
        ffmpegService.generateThumbnails(jobId, inputPath, thumbnailFolder, 3, (stage, pct) => {
          logger.debug(`Subtask thumbnails: ${pct}%`);
        }),
        ffmpegService.exportVideo(
          jobId,
          inputPath,
          outputPath,
          {
            resolution: options?.quality || '1080p',
            fps: options?.fps || 30,
          },
          (stage, percent) => {
            base['updateJobProgress'](jobId, userId, projectId, stage, percent);
          }
        ),
      ]);

      const stat = fs.statSync(outputPath);

      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.COMPLETED,
          progress: 100,
          currentStage: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      await creditLedger.consumeReservedCredits(userId, jobId, creditCost);

      const durationSec = (Date.now() - startTime) / 1000;
      await base['recordUsage'](userId, jobId, durationSec, stat.size, { input: 0, output: 0 }, 0.15);

      wsService.broadcastJobProgress({
        jobId,
        userId,
        projectId,
        status: JobStatus.COMPLETED,
        stage: 'COMPLETED',
        progress: 100,
        timestamp: new Date().toISOString(),
      });

      return { outputPath, size: stat.size };
    },
    {
      connection: redisConnection,
      concurrency: 2,
    }
  );

  setupWorkerErrorHandling(worker, QUEUE_NAMES.EXPORT, config.credits.standardExportCost);
  return worker;
}

function setupWorkerErrorHandling(worker: Worker<JobData>, queueName: string, creditCost: number) {
  const logger = appLogger.child(`${queueName}-ErrorHandler`);

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const { jobId, userId, projectId } = job.data;
    const { isRetryable, errorCode, message } = classifyError(err);
    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts || 3;

    logger.error(`Job ${jobId} failed on attempt ${attemptsMade}/${maxAttempts}: ${message}`, err, {
      jobId,
      isRetryable,
      errorCode,
    });

    if (err instanceof JobCancelledError) {
      // User cancellation path
      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.CANCELLED,
          cancelledAt: new Date(),
          errorCode: 'JOB_CANCELLED',
          errorMessage: 'Job was cancelled by user',
        },
      });

      await creditLedger.releaseReservedCredits(userId, jobId, creditCost);

      wsService.broadcastJobStatus({
        jobId,
        userId,
        projectId,
        status: JobStatus.CANCELLED,
        stage: 'CANCELLED',
        progress: 0,
        error: 'Job was cancelled',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (isRetryable && attemptsMade < maxAttempts) {
      // Retrying path
      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.RETRYING,
          errorCode,
          errorMessage: `Attempt ${attemptsMade} failed: ${message}`,
          attempts: attemptsMade,
        },
      });

      await prisma.jobEvent.create({
        data: {
          jobId,
          eventType: 'JOB_RETRYING',
          progress: 0,
          metadata: { attempt: attemptsMade, error: message },
        },
      });

      wsService.broadcastJobStatus({
        jobId,
        userId,
        projectId,
        status: JobStatus.RETRYING,
        stage: 'WAITING_FOR_RETRY',
        progress: 0,
        attempts: attemptsMade,
        error: message,
        timestamp: new Date().toISOString(),
      });
      // Terminal Failure / Dead-Letter path
      const existingDbJob = await prisma.processingJob.findUnique({ where: { id: jobId } });
      if (existingDbJob) {
        await prisma.processingJob.update({
          where: { id: jobId },
          data: {
            status: JobStatus.FAILED,
            errorCode,
            errorMessage: message,
            attempts: attemptsMade,
          },
        });

        await prisma.jobEvent.create({
          data: {
            jobId,
            eventType: 'JOB_FAILED_TERMINAL',
            progress: 0,
            metadata: { attempt: attemptsMade, error: message, errorCode },
          },
        });

        // Release reserved credits so user is never charged for failed jobs
        await creditLedger.releaseReservedCredits(userId, jobId, creditCost);
      }

      wsService.broadcastJobStatus({
        jobId,
        userId,
        projectId,
        status: JobStatus.FAILED,
        stage: 'FAILED',
        progress: 0,
        attempts: attemptsMade,
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  worker.on('error', (err) => {
    logger.error(`Worker internal queue error in ${queueName}`, err);
  });
}
