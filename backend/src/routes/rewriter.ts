import { asOpenApiSchema } from '../plugins/swagger.js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env, scaledRateLimit } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { withMeter } from '../services/meterGuard.js';
import { usageService } from '../services/usageService.js';

export const bulletRewriteBodySchema = z.object({
  resumeId: z.guid('Invalid resume UUID'),
  originalBullet: z
    .string()
    .min(1, 'originalBullet must not be empty')
    .max(500, 'originalBullet must not exceed 500 characters'),
  targetSkill: z.string().max(100).optional(),
  jobId: z.guid('Invalid job UUID').optional(),
});

/**
 * Fact-grounded STAR bullet rewriter routes — Phase 4B implementation.
 */
export const rewriterRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/rewriter/bullet',
    {
      schema: {
        tags: ['Rewriter'],
        summary: 'Rewrite bullet point for stronger impact and targeted skill alignment',
        body: asOpenApiSchema(bulletRewriteBodySchema),
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      config: {
        rateLimit: {
          max: scaledRateLimit(20),
          timeWindow: '1 minute',
        },
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const user = request.user as any;
      const userId: string = user.userId || user.sub;

      const bodyParse = bulletRewriteBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(422).send({
          type: 'https://api.resumatch.ai/errors/validation-error',
          title: 'Unprocessable Entity',
          status: 422,
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: bodyParse.error.issues.map((e) => e.message).join('; '),
          detail: bodyParse.error.issues.map((e) => e.message).join('; '),
        });
      }

      const { resumeId, originalBullet, targetSkill, jobId } = bodyParse.data;

      // 1. Verify resume ownership (404 convention)
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
          message: `Resume must be in PARSED status to rewrite bullets. Current status: ${resume.status}`,
          detail: `Resume must be in PARSED status to rewrite bullets. Current status: ${resume.status}`,
        });
      }

      // 3. Exact substring check in ParsedResume.rawText
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

      if (!parsedResume.rawText.includes(originalBullet)) {
        return reply.status(422).send({
          type: 'https://api.resumatch.ai/errors/bullet-not-in-resume',
          title: 'Unprocessable Entity',
          status: 422,
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'originalBullet must be an exact substring of ParsedResume.rawText',
          detail: 'originalBullet must be an exact substring of ParsedResume.rawText',
        });
      }

      // 4. Verify job ownership if jobId is supplied (404 convention; no free-text context)
      let jobText: string | null = null;
      if (jobId) {
        const job = await prisma.job.findUnique({ where: { id: jobId } });
        if (!job || job.userId !== userId) {
          return reply.status(404).send({
            type: 'https://api.resumatch.ai/errors/not-found',
            title: 'Not Found',
            status: 404,
            statusCode: 404,
            error: 'Not Found',
            message: 'Job not found',
            detail: 'Job not found',
          });
        }
        jobText = `${job.title}\n\n${job.rawDescription}`;
      }

      // 5. Invoke Python ML Rewriter service guarded by usage metering
      await withMeter(request, reply, 'analyses', async () => {
        try {
          const mlUrl = `${env.ML_SERVICE_URL}/v1/rewriter/bullet`;
          const mlRes = await fetch(mlUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Token': env.INTERNAL_API_TOKEN,
            },
            body: JSON.stringify({
              resumeId,
              originalBullet,
              resumeRawText: parsedResume.rawText,
              targetSkill: targetSkill || null,
              jobText,
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
                'HALLUCINATION_DETECTED: No rewritten options could be verified against source facts.',
              detail:
                errData.detail ||
                'HALLUCINATION_DETECTED: No rewritten options could be verified against source facts.',
            });
          }

          if (!mlRes.ok) {
            if (mlRes.status >= 500) {
              await usageService.refund(userId, 'analyses', 1);
            }
            const errData = (await mlRes.json().catch(() => ({}))) as any;
            return reply.status(mlRes.status).send({
              type: 'https://api.resumatch.ai/errors/rewriter-error',
              title: 'Rewriter Error',
              status: mlRes.status,
              statusCode: mlRes.status,
              error: 'Rewriter Error',
              message: errData.detail || 'Failed to rewrite bullet',
              detail: errData.detail || 'Failed to rewrite bullet',
            });
          }

          const data = await mlRes.json();
          return reply.status(200).send(data);
        } catch (err: any) {
          await usageService.refund(userId, 'analyses', 1);
          request.log.error({ err, resumeId }, 'Failed to connect to ML rewriter service');
          return reply.status(503).send({
            type: 'https://api.resumatch.ai/errors/service-unavailable',
            title: 'Service Unavailable',
            status: 503,
            statusCode: 503,
            error: 'Service Unavailable',
            message: 'ML rewriter service is currently unavailable',
            detail: 'ML rewriter service is currently unavailable',
          });
        }
      });
    }
  );
};
