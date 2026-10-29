import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env, scaledRateLimit } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { withMeter } from '../services/meterGuard.js';
import { usageService } from '../services/usageService.js';

export const improvementsParamsSchema = z.object({
  resumeId: z.guid('Invalid resume UUID'),
});

/**
 * Resume-only improvements and role suggestions route (Phase 4C).
 * Stateless endpoint providing ATS hazard remediation, content findings,
 * ML-ranked role suggestions, and LLM explanation.
 */
export const improvementsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/resumes/:resumeId/improvements',
    {
      config: {
        rateLimit: {
          max: scaledRateLimit(30),
          timeWindow: '1 minute',
        },
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const user = request.user as any;
      const userId: string = user.userId || user.sub;

      const paramsParse = improvementsParamsSchema.safeParse(request.params);
      if (!paramsParse.success) {
        return reply.status(422).send({
          type: 'https://api.resumatch.ai/errors/validation-error',
          title: 'Unprocessable Entity',
          status: 422,
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: paramsParse.error.issues.map((e) => e.message).join('; '),
          detail: paramsParse.error.issues.map((e) => e.message).join('; '),
        });
      }

      const { resumeId } = paramsParse.data;

      // 1. Verify resume ownership (404 convention for IDOR protection)
      const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
      if (!resume || resume.userId !== userId) {
        return reply.status(404).send({
          type: 'https://api.resumatch.ai/errors/not-found',
          title: 'Not Found',
          status: 404,
          statusCode: 404,
          error: 'Not Found',
          message: 'Resume not found',
          detail: 'Resume not found',
        });
      }

      // 2. Verify resume status is PARSED
      if (resume.status !== 'PARSED') {
        return reply.status(422).send({
          type: 'https://api.resumatch.ai/errors/invalid-state',
          title: 'Unprocessable Entity',
          status: 422,
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: `Resume must be in PARSED status to generate improvements. Current status: ${resume.status}`,
          detail: `Resume must be in PARSED status to generate improvements. Current status: ${resume.status}`,
        });
      }

      // 3. Verify ParsedResume exists with extracted text
      const parsedResume = await prisma.parsedResume.findUnique({ where: { resumeId } });
      if (!parsedResume || !parsedResume.rawText) {
        return reply.status(422).send({
          type: 'https://api.resumatch.ai/errors/no-text',
          title: 'Unprocessable Entity',
          status: 422,
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'Parsed resume text is missing or empty',
          detail: 'Parsed resume text is missing or empty',
        });
      }

      // 4. Invoke Python ML improvements service guarded by usage metering
      await withMeter(request, reply, 'analyses', async () => {
        try {
          const mlUrl = `${env.ML_SERVICE_URL}/v1/resumes/${resumeId}/improvements`;
          const mlRes = await fetch(mlUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Token': env.INTERNAL_API_TOKEN,
            },
            body: JSON.stringify({
              resumeId,
              resumeRawText: parsedResume.rawText,
              atsScore: parsedResume.atsScore,
              atsHazards: parsedResume.atsHazards || [],
              candidateSkills: parsedResume.skills || null,
            }),
          });

          if (mlRes.status === 422) {
            const errData = (await mlRes.json().catch(() => ({}))) as any;
            await usageService.refund(userId, 'analyses', 1);
            return reply.status(422).send({
              type: 'https://api.resumatch.ai/errors/hallucination-detected',
              title: 'Hallucination Detected',
              status: 422,
              statusCode: 422,
              error: 'Unprocessable Entity',
              message:
                errData.detail ||
                'HALLUCINATION_DETECTED: No improvements could be verified against source facts.',
              detail:
                errData.detail ||
                'HALLUCINATION_DETECTED: No improvements could be verified against source facts.',
            });
          }

          if (!mlRes.ok) {
            if (mlRes.status >= 500) {
              await usageService.refund(userId, 'analyses', 1);
            }
            const errData = (await mlRes.json().catch(() => ({}))) as any;
            return reply.status(mlRes.status).send({
              type: 'https://api.resumatch.ai/errors/improvements-error',
              title: 'Improvements Error',
              status: mlRes.status,
              statusCode: mlRes.status,
              error: 'Improvements Error',
              message: errData.detail || 'Failed to generate resume improvements',
              detail: errData.detail || 'Failed to generate resume improvements',
            });
          }

          const data = await mlRes.json();
          return reply.status(200).send(data);
        } catch (err: any) {
          await usageService.refund(userId, 'analyses', 1);
          request.log.error({ err, resumeId }, 'Failed to connect to ML improvements service');
          return reply.status(503).send({
            type: 'https://api.resumatch.ai/errors/service-unavailable',
            title: 'Service Unavailable',
            status: 503,
            statusCode: 503,
            error: 'Service Unavailable',
            message: 'ML improvements service is currently unavailable',
            detail: 'ML improvements service is currently unavailable',
          });
        }
      });
    }
  );
};
