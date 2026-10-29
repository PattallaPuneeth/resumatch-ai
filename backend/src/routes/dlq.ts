import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  MONITORED_QUEUES,
  getDlqName,
  getDlqSummary,
  getDlqJobs,
  replayDlqJobs,
  purgeDlqQueue,
} from '../queues/dlq.js';
import { asOpenApiSchema } from '../plugins/swagger.js';
import { env } from '../config/env.js';

const queueParamsSchema = z.object({
  queueName: z.enum(MONITORED_QUEUES as unknown as [string, ...string[]]),
});

const listJobsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const retryBodySchema = z.object({
  jobId: z.string().optional(),
});

export const dlqRoutes: FastifyPluginAsync = async (app) => {
  // Combined Authentication & Authorization handler for admin DLQ routes
  const authDLQ = async (request: FastifyRequest, reply: FastifyReply) => {
    const internalToken = request.headers['x-internal-token'];
    if (internalToken && internalToken === env.INTERNAL_API_TOKEN) {
      return;
    }
    await app.authenticate(request, reply);
    if (reply.sent) return;

    const user = request.user as { role?: string } | undefined;
    if (user && (user.role === 'ADMIN' || env.NODE_ENV !== 'production')) {
      return;
    }
    return reply.status(403).send({
      type: 'https://httpstatuses.com/403',
      title: 'Forbidden',
      status: 403,
      detail: 'Admin privileges or valid internal token required to access DLQ management',
      instance: request.url,
    });
  };

  // GET /v1/admin/dlq - Summary of all monitored DLQs
  app.get(
    '/v1/admin/dlq',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Retrieve summary counts for all dead letter queues',
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      preHandler: authDLQ,
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const summary = await getDlqSummary();
      return reply.send({
        queues: summary,
        totalFailedAcrossQueues: summary.reduce((acc, q) => acc + q.counts.failed + q.counts.waiting, 0),
        monitoredQueuesCount: summary.length,
      });
    }
  );

  // GET /v1/admin/dlq/:queueName - List failed jobs in a specific DLQ
  app.get(
    '/v1/admin/dlq/:queueName',
    {
      schema: {
        tags: ['Admin'],
        summary: 'List jobs in a specific dead letter queue',
        params: asOpenApiSchema(queueParamsSchema),
        querystring: asOpenApiSchema(listJobsQuerySchema),
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      preHandler: authDLQ,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = queueParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({
          type: 'https://httpstatuses.com/400',
          title: 'Bad Request',
          status: 400,
          detail: `Invalid queue name. Allowed: ${MONITORED_QUEUES.join(', ')}`,
          instance: request.url,
        });
      }

      const queryResult = listJobsQuerySchema.safeParse(request.query);
      const query = queryResult.success ? queryResult.data : { offset: 0, limit: 20 };
      const { queueName } = paramsResult.data;

      const jobs = await getDlqJobs(queueName, query.offset, query.limit);
      return reply.send({
        queue: queueName,
        dlqName: getDlqName(queueName),
        offset: query.offset,
        limit: query.limit,
        jobsCount: jobs.length,
        jobs,
      });
    }
  );

  // POST /v1/admin/dlq/:queueName/retry - Replay jobs from DLQ
  app.post(
    '/v1/admin/dlq/:queueName/retry',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Replay dead letter queue jobs back to original active queue',
        params: asOpenApiSchema(queueParamsSchema),
        body: asOpenApiSchema(retryBodySchema),
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      preHandler: authDLQ,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = queueParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({
          type: 'https://httpstatuses.com/400',
          title: 'Bad Request',
          status: 400,
          detail: `Invalid queue name. Allowed: ${MONITORED_QUEUES.join(', ')}`,
          instance: request.url,
        });
      }

      const bodyResult = retryBodySchema.safeParse(request.body || {});
      const jobId = bodyResult.success ? bodyResult.data.jobId : undefined;
      const { queueName } = paramsResult.data;

      const result = await replayDlqJobs(queueName, jobId);
      return reply.send({
        success: true,
        queue: queueName,
        dlqName: getDlqName(queueName),
        ...result,
      });
    }
  );

  // POST /v1/admin/dlq/:queueName/purge - Clear all jobs in a DLQ
  app.post(
    '/v1/admin/dlq/:queueName/purge',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Purge all dead letter queue jobs from a DLQ',
        params: asOpenApiSchema(queueParamsSchema),
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      preHandler: authDLQ,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = queueParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({
          type: 'https://httpstatuses.com/400',
          title: 'Bad Request',
          status: 400,
          detail: `Invalid queue name. Allowed: ${MONITORED_QUEUES.join(', ')}`,
          instance: request.url,
        });
      }

      const { queueName } = paramsResult.data;
      const purged = await purgeDlqQueue(queueName);
      return reply.send({
        success: true,
        queue: queueName,
        dlqName: getDlqName(queueName),
        purged,
      });
    }
  );
};
