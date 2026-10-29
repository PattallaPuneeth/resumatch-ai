import type { FastifyPluginAsync } from 'fastify';
import { checkDatabaseHealth } from '../db/prisma.js';
import { checkRedisHealth } from '../queues/redis.js';
import { checkMinioHealth } from '../storage/minio.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Check API gateway, database, redis and object storage health',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'healthy' },
              timestamp: { type: 'string', format: 'date-time' },
              version: { type: 'string', example: '1.0.0' },
              services: { type: 'object', additionalProperties: true },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'unhealthy' },
              timestamp: { type: 'string', format: 'date-time' },
              version: { type: 'string', example: '1.0.0' },
              services: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (_request, reply) => {
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
          s3: minioHealth,
        },
      });
    }
  );
};
