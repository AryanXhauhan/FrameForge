import { Queue, QueueEvents } from 'bullmq';
import { redisConnection } from '../config/database';
import { appLogger } from '../utils/logger';

export const QUEUE_NAMES = {
  PROXY: 'frameforge-proxy-queue',
  TRANSCODE: 'frameforge-transcode-queue',
  AI: 'frameforge-ai-queue',
  EXPORT: 'frameforge-export-queue',
} as const;

export interface JobData {
  jobId: string;
  userId: string;
  projectId: string;
  mediaAssetId?: string;
  type: string;
  inputPath: string;
  outputPath?: string;
  options?: any;
  priority?: number;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000, // 2s, 4s, 8s...
  },
  removeOnComplete: {
    age: 24 * 3600, // keep 24 hours for audit
    count: 1000,
  },
  removeOnFail: {
    age: 48 * 3600,
    count: 2000,
  },
};

const logger = appLogger.child('Queues');

export const proxyQueue = new Queue<JobData>(QUEUE_NAMES.PROXY, {
  connection: redisConnection,
  defaultJobOptions,
});

export const transcodeQueue = new Queue<JobData>(QUEUE_NAMES.TRANSCODE, {
  connection: redisConnection,
  defaultJobOptions,
});

export const aiQueue = new Queue<JobData>(QUEUE_NAMES.AI, {
  connection: redisConnection,
  defaultJobOptions,
});

export const exportQueue = new Queue<JobData>(QUEUE_NAMES.EXPORT, {
  connection: redisConnection,
  defaultJobOptions,
});

export const allQueues = [proxyQueue, transcodeQueue, aiQueue, exportQueue];

export async function getQueueMetrics() {
  const metrics: Record<string, any> = {};

  for (const q of allQueues) {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
      q.getDelayedCount(),
    ]);

    metrics[q.name] = {
      waiting,
      active,
      completed,
      failed,
      delayed,
      totalDepth: waiting + active + delayed,
    };
  }

  return metrics;
}
