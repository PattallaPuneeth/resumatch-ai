import { Queue, Worker, Job } from 'bullmq';
import { redisConnectionOptions } from './bullmq.js';
import { run24HourCleanup, CleanupResult } from '../services/cleanupService.js';

export interface CleanupJobPayload {
  trigger: 'SCHEDULED' | 'MANUAL';
  timestamp: string;
}

export const CLEANUP_QUEUE_NAME = 'cleanup-queue';
export const CLEANUP_JOB_NAME = 'maintenance-24h-cleanup';

export const cleanupQueue = new Queue<CleanupJobPayload>(CLEANUP_QUEUE_NAME, {
  connection: redisConnectionOptions,
  prefix: 'bull',
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 20,
    removeOnFail: 50,
  },
});

let cleanupWorker: Worker<CleanupJobPayload, CleanupResult> | null = null;

export async function processCleanupJob(
  _job: Job<CleanupJobPayload>
): Promise<CleanupResult> {
  return run24HourCleanup();
}

/**
 * Registers the repeatable hourly cleanup job in BullMQ.
 * Idempotent: removes older repeatables for the job name before re-adding.
 */
export async function registerScheduledCleanupJob(
  cronPattern = '0 * * * *' // Every hour
): Promise<void> {
  try {
    const existingRepeatables = await cleanupQueue.getRepeatableJobs();
    for (const rj of existingRepeatables) {
      if (rj.name === CLEANUP_JOB_NAME) {
        await cleanupQueue.removeRepeatableByKey(rj.key);
      }
    }

    await cleanupQueue.add(
      CLEANUP_JOB_NAME,
      {
        trigger: 'SCHEDULED',
        timestamp: new Date().toISOString(),
      },
      {
        repeat: {
          pattern: cronPattern,
        },
        jobId: 'scheduled-24h-cleanup',
      }
    );
  } catch (err) {
    console.error('Failed to register scheduled cleanup job:', err);
  }
}

/**
 * Starts the BullMQ background worker for cleanup queue.
 */
export function startCleanupWorker(): Worker<CleanupJobPayload, CleanupResult> {
  if (cleanupWorker) {
    return cleanupWorker;
  }

  cleanupWorker = new Worker<CleanupJobPayload, CleanupResult>(
    CLEANUP_QUEUE_NAME,
    async (job: Job<CleanupJobPayload>) => {
      return processCleanupJob(job);
    },
    {
      connection: redisConnectionOptions,
      prefix: 'bull',
      concurrency: 1, // Single concurrency ensures no concurrent cleanup runs
    }
  );

  return cleanupWorker;
}

/**
 * Shuts down worker and queue gracefully on server termination.
 */
export async function stopCleanupWorker(): Promise<void> {
  if (cleanupWorker) {
    await cleanupWorker.close();
    cleanupWorker = null;
  }
  await cleanupQueue.close();
}
