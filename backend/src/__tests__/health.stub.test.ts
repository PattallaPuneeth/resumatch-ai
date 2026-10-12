import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as prismaModule from '../db/prisma.js';
import * as redisModule from '../queues/redis.js';
import { buildServer } from '../server.js';
import * as minioModule from '../storage/minio.js';

describe('GET /health endpoint', () => {
  const app = buildServer();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should return 200 and healthy status when all services are healthy', async () => {
    vi.spyOn(prismaModule, 'checkDatabaseHealth').mockResolvedValue({
      status: 'healthy',
      latencyMs: 3,
    });
    vi.spyOn(redisModule, 'checkRedisHealth').mockResolvedValue({
      status: 'healthy',
      latencyMs: 1,
    });
    vi.spyOn(minioModule, 'checkMinioHealth').mockResolvedValue({
      status: 'healthy',
      latencyMs: 5,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('healthy');
    expect(body.services.postgres.status).toBe('healthy');
    expect(body.services.redis.status).toBe('healthy');
    expect(body.services.minio.status).toBe('healthy');
  });

  it('should return 503 when any service is unhealthy', async () => {
    vi.spyOn(prismaModule, 'checkDatabaseHealth').mockResolvedValue({
      status: 'unhealthy',
      latencyMs: 10,
      error: 'Connection timeout',
    });
    vi.spyOn(redisModule, 'checkRedisHealth').mockResolvedValue({
      status: 'healthy',
      latencyMs: 2,
    });
    vi.spyOn(minioModule, 'checkMinioHealth').mockResolvedValue({
      status: 'healthy',
      latencyMs: 4,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('unhealthy');
    expect(body.services.postgres.status).toBe('unhealthy');
    expect(body.services.postgres.error).toBe('Connection timeout');
    expect(body.services.redis.status).toBe('healthy');
    expect(body.services.minio.status).toBe('healthy');
  });
});
