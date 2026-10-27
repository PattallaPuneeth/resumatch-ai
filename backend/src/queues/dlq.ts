/**
 * Phase 10A - Item C3: Dead Letter Queue (DLQ) Management
 *
 * Implements dedicated dead-letter queues for all primary BullMQ queues,
 * allowing failed jobs that exceed retry limits or encounter non-retryable
 * errors to be captured, inspected, and replayed safely.
 */

import { Queue, Job } from 'bullmq';
import { redisConnectionOptions } from './bullmq.js';

export interface DlqJobPayload<T = any> {
  originalQueue: string;
  originalJobId: string;
  payload: T;
  failedAt: string;
  attemptsMade: number;
  errorMessage: string;
  errorStack?: string;
}

export const MONITORED_QUEUES = [
  'resume-parsing-queue',
  'embedding-queue',
  'match-scoring-queue',
  'analysis-queue',
  'cleanup-queue',
] as const;

export type MonitoredQueueName = (typeof MONITORED_QUEUES)[number];

const dlqInstances = new Map<string, Queue>();

export function getDlqName(queueName: string): string {
  return `${queueName}-dlq`;
}

export function getDlqQueue(queueName: string): Queue<DlqJobPayload> {
  const dlqName = getDlqName(queueName);
  let queue = dlqInstances.get(dlqName);
  if (!queue) {
    queue = new Queue<DlqJobPayload>(dlqName, {
      connection: redisConnectionOptions,
      prefix: 'bull',
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    });
    dlqInstances.set(dlqName, queue);
  }
  return queue as Queue<DlqJobPayload>;
}

/**
 * Moves a failed job and its diagnostic context into the appropriate DLQ.
 */
export async function moveToDlq<T = any>(
  originalQueue: string,
  job: { id?: string; data: T; attemptsMade?: number },
  error: Error | { message: string; stack?: string }
): Promise<Job<DlqJobPayload<T>>> {
  const dlq = getDlqQueue(originalQueue);
  const dlqPayload: DlqJobPayload<T> = {
    originalQueue,
    originalJobId: job.id || 'unknown',
    payload: job.data,
    failedAt: new Date().toISOString(),
    attemptsMade: job.attemptsMade || 0,
    errorMessage: error.message || String(error),
    errorStack: error.stack,
  };

  return dlq.add(`dlq-${originalQueue}`, dlqPayload, {
    jobId: `dlq-${originalQueue}-${job.id || Date.now()}`,
  });
}

/**
 * Replays a job from the DLQ back to its original queue.
 */
export async function retryDlqJob(
  dlqQueueName: string,
  jobId: string,
  targetQueue: Queue
): Promise<boolean> {
  const dlq = dlqInstances.get(dlqQueueName) || new Queue(dlqQueueName, {
    connection: redisConnectionOptions,
    prefix: 'bull',
  });

  const job = await dlq.getJob(jobId);
  if (!job) {
    return false;
  }

  const { originalQueue, payload } = job.data;
  await targetQueue.add(`retry-${originalQueue}`, payload);
  await job.remove();
  return true;
}

/**
 * Closes all active DLQ connection handles (used during graceful shutdown and tests).
 */
export async function closeDlqQueues(): Promise<void> {
  for (const queue of dlqInstances.values()) {
    await queue.close();
  }
  dlqInstances.clear();
}
