import {
  createProxyWorker,
  createTranscodeWorker,
  createAIWorker,
  createExportWorker,
} from './job.workers';
import { jobRecoveryService } from './job-recovery.service';
import { appLogger } from '../utils/logger';

const logger = appLogger.child('WorkerRunner');

export async function startWorkerProcesses() {
  logger.info('Initializing FrameForge BullMQ Worker Cluster...');

  // 1. Run recovery for any jobs left in PROCESSING by a previously crashed process
  try {
    await jobRecoveryService.recoverOrphanedJobs();
  } catch (err: any) {
    logger.error('Failed to run initial recovery', err);
  }

  // 2. Instantiate workers
  const proxyWorker = createProxyWorker();
  const transcodeWorker = createTranscodeWorker();
  const aiWorker = createAIWorker();
  const exportWorker = createExportWorker();

  const workers = [proxyWorker, transcodeWorker, aiWorker, exportWorker];
  logger.info(`All ${workers.length} workers initialized and listening for jobs.`);

  // 3. Periodic crash/stall check every 30 seconds
  const recoveryInterval = setInterval(() => {
    jobRecoveryService.recoverOrphanedJobs().catch((err) => {
      logger.error('Error during periodic stalled job check', err);
    });
  }, 30000);

  // 4. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down worker processes gracefully...`);
    clearInterval(recoveryInterval);

    await Promise.all(workers.map((w) => w.close()));
    logger.info('All workers shut down cleanly.');
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { workers, shutdown };
}

// If invoked directly from CLI (e.g. `npm run worker`)
if (require.main === module) {
  startWorkerProcesses().catch((err) => {
    logger.error('Fatal worker process error', err);
    process.exit(1);
  });
}
