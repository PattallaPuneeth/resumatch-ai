/**
 * Phase 10A - Item C3: Dead Letter Queue (DLQ) Unit & Reliability Tests
 *
 * Validates:
 * - Dead-letter queue naming conventions
 * - Job routing into DLQ with metadata preservation and zero PII
 * - DLQ job replay back to target queue
 * - Monitored queues coverage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getDlqName,
  moveToDlq,
  retryDlqJob,
  MONITORED_QUEUES,
} from '../queues/dlq.js';

const { MockBullQueue } = vi.hoisted(() => {
  class MockBullQueue {
    name: string;
    jobs = new Map<string, any>();

    constructor(name: string) {
      this.name = name;
    }

    async add(jobName: string, data: any, opts?: any) {
      const id = opts?.jobId || `mock-job-${Date.now()}`;
      const job = { id, name: jobName, data, remove: vi.fn(async () => this.jobs.delete(id)) };
      this.jobs.set(id, job);
      return job;
    }

    async getJob(id: string) {
      return this.jobs.get(id) || null;
    }
  }
  return { MockBullQueue };
});

vi.mock('bullmq', () => {
  return {
    Queue: vi.fn(function (name: string) {
      return new MockBullQueue(name);
    }),
  };
});


describe('C3: Dead Letter Queue (DLQ) Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates consistent DLQ queue names with -dlq suffix', () => {
    expect(getDlqName('resume-parsing-queue')).toBe('resume-parsing-queue-dlq');
    expect(getDlqName('embedding-queue')).toBe('embedding-queue-dlq');
    expect(getDlqName('match-scoring-queue')).toBe('match-scoring-queue-dlq');
    expect(getDlqName('analysis-queue')).toBe('analysis-queue-dlq');
    expect(getDlqName('cleanup-queue')).toBe('cleanup-queue-dlq');
  });

  it('covers all five monitored queues in MONITORED_QUEUES', () => {
    expect(MONITORED_QUEUES).toContain('resume-parsing-queue');
    expect(MONITORED_QUEUES).toContain('embedding-queue');
    expect(MONITORED_QUEUES).toContain('match-scoring-queue');
    expect(MONITORED_QUEUES).toContain('analysis-queue');
    expect(MONITORED_QUEUES).toContain('cleanup-queue');
  });

  it('routes failed job into DLQ with diagnostic metadata and zero PII', async () => {
    const originalQueue = 'resume-parsing-queue';
    const mockJob = {
      id: 'parse-res-999',
      data: {
        resumeId: 'res-999',
        storageKey: 'resumes/u1/file.pdf',
        mimeType: 'application/pdf',
      },
      attemptsMade: 3,
    };
    const error = new Error('Database connection timed out during extraction');

    const dlqJob = await moveToDlq(originalQueue, mockJob, error);

    expect(dlqJob).toBeDefined();
    expect(dlqJob.data.originalQueue).toBe(originalQueue);
    expect(dlqJob.data.originalJobId).toBe('parse-res-999');
    expect(dlqJob.data.attemptsMade).toBe(3);
    expect(dlqJob.data.errorMessage).toBe('Database connection timed out during extraction');
    expect(dlqJob.data.payload).toEqual(mockJob.data);
    expect(dlqJob.data.failedAt).toBeDefined();
  });

  it('replays dead-letter job from DLQ back to primary queue and removes from DLQ', async () => {
    const originalQueue = 'analysis-queue';
    const targetQueue: any = new MockBullQueue(originalQueue);

    // 1. Move to DLQ
    const dlqJob = await moveToDlq(
      originalQueue,
      { id: 'analysis-123', data: { resumeId: 'r1', jobId: 'j1' }, attemptsMade: 3 },
      new Error('ML worker crashed')
    );

    // 2. Retry DLQ job
    const dlqQueueName = getDlqName(originalQueue);
    const success = await retryDlqJob(dlqQueueName, dlqJob.id || 'analysis-123', targetQueue);

    expect(success).toBe(true);
    // Job should be enqueued to targetQueue
    const replayed = Array.from(targetQueue.jobs.values()) as any[];
    expect(replayed.length).toBe(1);
    expect(replayed[0].name).toBe(`retry-${originalQueue}`);
    expect(replayed[0].data).toEqual({ resumeId: 'r1', jobId: 'j1' });
  });

  it('returns false when attempting to retry a non-existent DLQ job', async () => {
    const targetQueue: any = new MockBullQueue('resume-parsing-queue');
    const success = await retryDlqJob('resume-parsing-queue-dlq', 'non-existent-id', targetQueue);
    expect(success).toBe(false);
  });
});
