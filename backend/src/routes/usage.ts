import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { usageService } from '../services/usageService.js';

/**
 * Usage metrics route — Phase 6 implementation.
 *
 * GET /v1/usage
 *   - Authenticated read-only usage metrics
 *   - Cache-Control: no-store
 *   - Returns per-meter used, limit, unlimited, percent, activeThreshold, crossedThresholds, blocked, periodStart, resetAt, and plan.
 */
export const usageRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/usage',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;
      const userId: string = user?.userId || user?.sub;

      if (!userId) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const usage = await usageService.getUsage(userId);

      return reply
        .header('Cache-Control', 'no-store')
        .status(200)
        .send(usage);
    }
  );
};
