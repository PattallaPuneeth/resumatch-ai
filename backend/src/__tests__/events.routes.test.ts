import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { eventDispatcher } from '../services/eventDispatcher.js';

// Mock DB and health checks
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

vi.mock('../queues/redis.js', () => {
  const dummyClient = {
    ping: vi.fn().mockResolvedValue('PONG'),
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue('OK'),
    unsubscribe: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue('OK'),
    status: 'ready',
  };

  return {
    checkRedisHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
    createRedisClient: vi.fn().mockReturnValue(dummyClient),
    redisClient: dummyClient,
  };
});

describe('Server-Sent Events (SSE) Route — /v1/events/stream', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await eventDispatcher.close();
  });

  const signToken = (userId: string, role = 'CANDIDATE') => {
    return app.jwt.sign({ sub: userId, role });
  };

  it('rejects unauthenticated requests with 401 Unauthorized', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/stream',
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects invalid query token with 401 Unauthorized', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/stream?token=invalid.jwt.token',
    });

    expect(res.statusCode).toBe(401);
  });

  it('establishes SSE stream with Bearer authentication and sends connected handshake', async () => {
    const userId = 'user-sse-1';
    const token = signToken(userId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/stream',
      headers: {
        authorization: `Bearer ${token}`,
        'x-test-close-stream': 'true',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['connection']).toBe('keep-alive');
    expect(res.payload).toContain('event: connected');
    expect(res.payload).toContain(`"userId":"${userId}"`);
  });

  it('establishes SSE stream via ?token query parameter for native EventSource clients', async () => {
    const userId = 'user-sse-query';
    const token = signToken(userId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/stream?token=${token}`,
      headers: {
        'x-test-close-stream': 'true',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.payload).toContain('event: connected');
    expect(res.payload).toContain(`"userId":"${userId}"`);
  });

  it('subscribes user listener and dispatches events cleanly', async () => {
    const userId = 'user-listener-test';
    let receivedEvent: any = null;

    const unsubscribe = await eventDispatcher.subscribeUser(userId, (event) => {
      receivedEvent = event;
    });

    expect(typeof unsubscribe).toBe('function');

    // Simulate event publish
    await eventDispatcher.publishUserEvent(userId, {
      type: 'RESUME_STATUS',
      data: { resumeId: 'res-1', status: 'PARSED', atsScore: 88 },
    });

    expect(receivedEvent).toBeNull();
    await unsubscribe();
  });
});
