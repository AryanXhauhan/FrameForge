import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../config/database';
import { proxyQueue, transcodeQueue, aiQueue, exportQueue } from '../queues/job.queue';
import { creditLedger } from '../services/credit-ledger.service';
import { appLogger } from '../utils/logger';
import { config } from '../config/env';

const logger = appLogger.child('WorkerRecovery');

export class JobRecoveryService {
  /**
   * Run upon worker startup or watchdog timer to recover jobs that were left
   * in PROCESSING state when a previous worker process crashed or died abruptly.
   */
  async recoverOrphanedJobs(): Promise<number> {
    logger.info('Checking for stalled or orphaned jobs in PROCESSING state...');

    // Find jobs stuck in PROCESSING or RETRYING without an active heartbeat (> 60 seconds old)
    const threshold = new Date(Date.now() - 60 * 1000);
    const stuckJobs = await prisma.processingJob.findMany({
      where: {
        status: { in: [JobStatus.PROCESSING, JobStatus.RETRYING] },
        updatedAt: { lt: threshold },
      },
    });

    if (stuckJobs.length === 0) {
      logger.info('No orphaned jobs detected.');
      return 0;
    }

    logger.warn(`Discovered ${stuckJobs.length} orphaned jobs. Initiating recovery...`);
    let recoveredCount = 0;

    for (const job of stuckJobs) {
      try {
        if (job.attempts < job.maxAttempts) {
          logger.info(`Re-queueing orphaned job ${job.id} (Attempt ${job.attempts + 1}/${job.maxAttempts})`);

          await prisma.processingJob.update({
            where: { id: job.id },
            data: {
              status: JobStatus.QUEUED,
              currentStage: 'QUEUED_FOR_RECOVERY',
              attempts: { increment: 1 },
              errorMessage: 'Recovered after worker crash/restart',
            },
          });

          await prisma.jobEvent.create({
            data: {
              jobId: job.id,
              eventType: 'JOB_RECOVERED_AFTER_CRASH',
              progress: 0,
              metadata: { previousStatus: job.status, attempts: job.attempts + 1 },
            },
          });

          // Fetch media path
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

          // Push back to appropriate queue
          if (job.type === JobType.PROXY_GENERATION) {
            await proxyQueue.add(`recovery-proxy-${job.id}`, jobPayload);
          } else if (job.type === JobType.TRANSCODE) {
            await transcodeQueue.add(`recovery-transcode-${job.id}`, jobPayload);
          } else if (job.type === JobType.AI_ANALYSIS) {
            await aiQueue.add(`recovery-ai-${job.id}`, jobPayload);
          } else if (job.type === JobType.EXPORT) {
            await exportQueue.add(`recovery-export-${job.id}`, jobPayload);
          }

          recoveredCount++;
        } else {
          logger.warn(`Orphaned job ${job.id} exceeded max attempts. Moving to FAILED and releasing credits.`);

          await prisma.processingJob.update({
            where: { id: job.id },
            data: {
              status: JobStatus.FAILED,
              errorCode: 'WORKER_CRASH_MAX_ATTEMPTS_EXCEEDED',
              errorMessage: 'Job failed permanently after worker died repeatedly',
            },
          });

          let cost = config.credits.proxyCost;
          if (job.type === JobType.AI_ANALYSIS) cost = config.credits.aiCost;
          if (job.type === JobType.EXPORT) cost = config.credits.standardExportCost;

          await creditLedger.releaseReservedCredits(job.userId, job.id, cost);
        }
      } catch (err: any) {
        logger.error(`Failed recovering job ${job.id}`, err);
      }
    }

    return recoveredCount;
  }
}

export const jobRecoveryService = new JobRecoveryService();
