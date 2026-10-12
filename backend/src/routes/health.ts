import type { FastifyPluginAsync } from 'fastify';
import { checkDatabaseHealth } from '../db/prisma.js';
import { checkRedisHealth } from '../queues/redis.js';
import { checkMinioHealth } from '../storage/minio.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_request, reply) => {
    const [postgresHealth, redisHealth, minioHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
      checkMinioHealth(),
    ]);

    const isHealthy =
      postgresHealth.status === 'healthy' &&
      redisHealth.status === 'healthy' &&
      minioHealth.status === 'healthy';

    const statusCode = isHealthy ? 200 : 503;

    return reply.status(statusCode).send({
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        postgres: postgresHealth,
        redis: redisHealth,
        minio: minioHealth,
      },
    });
  });
};
