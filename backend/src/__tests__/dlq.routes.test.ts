import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';

// Mock DLQ queue methods
vi.mock('../queues/dlq.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../queues/dlq.js')>();
  return {
    ...original,
    getDlqSummary: vi.fn().mockResolvedValue([
      {
        queue: 'resume-parsing-queue',
        dlqName: 'resume-parsing-queue-dlq',
        counts: { waiting: 2, active: 0, completed: 5, failed: 1, total: 8 },
      },
      {
        queue: 'embedding-queue',
        dlqName: 'embedding-queue-dlq',
        counts: { waiting: 0, active: 0, completed: 10, failed: 0, total: 10 },
      },
    ]),
    getDlqJobs: vi.fn().mockResolvedValue([
      {
        id: 'job-failed-123',
        name: 'dlq-resume-parsing-queue',
        data: {
          originalQueue: 'resume-parsing-queue',
          originalJobId: 'parse-resume-1',
          errorMessage: 'Corrupt file header',
          failedAt: '2026-10-29T20:00:00.000Z',
          attemptsMade: 3,
        },
        timestamp: Date.now(),
        failedReason: 'Corrupt file header',
      },
    ]),
    replayDlqJobs: vi.fn().mockResolvedValue({ replayed: 1, failed: 0 }),
    purgeDlqQueue: vi.fn().mockResolvedValue(2),
  };
});

// Mock database health and storage
vi.mock('../db/prisma.js', () => ({
  prisma: {
    session: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  checkDatabaseHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
  configureDatabaseUrl: vi.fn((url: string) => url),
}));

vi.mock('../storage/minio.js', () => ({
  checkMinioHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

vi.mock('../queues/redis.js', () => ({
  checkRedisHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
  getRedisClient: vi.fn().mockReturnValue({
    ping: vi.fn().mockResolvedValue('PONG'),
  }),
}));

describe('Admin Dead Letter Queue (DLQ) Management Routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const makeAuthHeader = (userId = 'admin-user-1') => {
    const token = app.jwt.sign({ sub: userId, role: 'ADMIN' });
    return { authorization: `Bearer ${token}` };
  };

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/dlq',
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/admin/dlq returns summary for all monitored DLQs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/dlq',
      headers: makeAuthHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queues).toHaveLength(2);
    expect(body.queues[0].queue).toBe('resume-parsing-queue');
    expect(body.totalFailedAcrossQueues).toBe(3);
  });

  it('GET /v1/admin/dlq/:queueName returns 400 for unknown queue', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/dlq/nonexistent-queue',
      headers: makeAuthHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().title).toBe('Bad Request');
  });

  it('GET /v1/admin/dlq/:queueName returns list of jobs for valid queue', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/dlq/resume-parsing-queue?offset=0&limit=10',
      headers: makeAuthHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queue).toBe('resume-parsing-queue');
    expect(body.jobsCount).toBe(1);
    expect(body.jobs[0].id).toBe('job-failed-123');
  });

  it('POST /v1/admin/dlq/:queueName/retry replays jobs from DLQ', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/dlq/resume-parsing-queue/retry',
      headers: {
        ...makeAuthHeader(),
        'content-type': 'application/json',
      },
      payload: { jobId: 'job-failed-123' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.replayed).toBe(1);
    expect(body.failed).toBe(0);
  });

  it('POST /v1/admin/dlq/:queueName/purge clears dead letter jobs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/dlq/resume-parsing-queue/purge',
      headers: makeAuthHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.purged).toBe(2);
  });
});

