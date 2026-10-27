import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { scaledRateLimit } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { analysisQueue, embeddingQueue, matchScoringQueue } from '../queues/bullmq.js';
import { withMeter } from '../services/meterGuard.js';
import { usageService } from '../services/usageService.js';
import { withTraceContext } from '../telemetry.js';

// ---------------------------------------------------------------------------
// Validation Schemas
// ---------------------------------------------------------------------------
export const createJobBodySchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title too long'),
  company: z.string().min(1, 'Company is required').max(200, 'Company too long'),
  rawDescription: z.string().min(20, 'Job description must be at least 20 characters'),
  location: z.string().max(200).optional(),
  jobType: z.string().max(50).optional(),
  requiredSkills: z.array(z.string()).optional(),
  preferredSkills: z.array(z.string()).optional(),
  experienceLevel: z.string().max(50).optional(),
});

export const matchJobBodySchema = z.object({
  resumeId: z.string().uuid('Invalid resume UUID'),
});

export const analysisJobBodySchema = z.object({
  resumeId: z.string().uuid('Invalid resume UUID'),
});

/**
 * Job and Match routes — Phase 3B implementation.
 *
 * Implemented endpoints:
 *   POST /v1/jobs                    → create a job description & enqueue embedding (Phase 3B)
 *   GET  /v1/jobs/:id                → retrieve job details and chunk count (Phase 3B)
 *   POST /v1/jobs/:id/match          → trigger hybrid retrieval & cross-encoder matching (Phase 3B)
 *   GET  /v1/jobs/:id/matches/:resumeId → retrieve match result, scores, and skill gap (Phase 3B)
 *
 * Legacy unversioned / unimplemented routes return 501.
 */
export const jobsRoutes: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // Phase 3B: POST /v1/jobs
  // -------------------------------------------------------------------------
  app.post(
    '/v1/jobs',
    {
      config: {
        rateLimit: {
          max: scaledRateLimit(20),
          timeWindow: '1 minute',
        },
      },
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;
      const userId: string = user.userId || user.sub;

      const parseResult = createJobBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: parseResult.error.errors.map((e) => e.message).join('; '),
        });
      }

      const data = parseResult.data;

      // 1. Create Job record
      const job = await prisma.job.create({
        data: {
          userId: userId,
          title: data.title,
          company: data.company,
          rawDescription: data.rawDescription,
          location: data.location || null,
          jobType: data.jobType || null,
          requiredSkills: data.requiredSkills || [],
          preferredSkills: data.preferredSkills || [],
          experienceLevel: data.experienceLevel || null,
          status: 'ACTIVE',
        },
      });

      // 2. Enqueue EMBED_DOCUMENT job to embedding-queue
      try {
        await embeddingQueue.add(
          `embed-job-${job.id}`,
          withTraceContext(request, {
            type: 'EMBED_DOCUMENT',
            entityType: 'JOB',
            entityId: job.id,
            jobId: job.id,
          }),
          {
            jobId: `embed-job-${job.id}`,
          }
        );
      } catch (queueErr) {
        request.log.error({ err: queueErr, jobId: job.id }, 'Failed to enqueue embedding job for Job');
        return reply.status(503).send({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'Failed to enqueue job embedding task',
        });
      }

      return reply.status(201).send({
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        jobType: job.jobType,
        status: job.status,
        createdAt: job.createdAt,
      });
    }
  );

  // -------------------------------------------------------------------------
  // Phase 3B: GET /v1/jobs/:id
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/jobs/:id',
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const user = request.user as any;
      const userId: string = user.userId || user.sub;
      const { id } = request.params;

      const job = await prisma.job.findUnique({
        where: { id },
        include: {
          _count: {
            select: { chunks: true },
          },
        },
      });

      if (!job || job.userId !== userId) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Job not found',
        });
      }

      return reply.status(200).send({
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        jobType: job.jobType,
        rawDescription: job.rawDescription,
        requiredSkills: job.requiredSkills,
        preferredSkills: job.preferredSkills,
        experienceLevel: job.experienceLevel,
        status: job.status,
        chunkCount: job._count.chunks,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    }
  );

  // -------------------------------------------------------------------------
  // Phase 3B: POST /v1/jobs/:id/match
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/jobs/:id/match',
    {
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
      const { id: jobId } = request.params;

      const bodyParse = matchJobBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: bodyParse.error.errors.map((e) => e.message).join('; '),
        });
      }

      const { resumeId } = bodyParse.data;

      // Verify that BOTH the job and the resume belong to the authenticated user (404 convention)
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      if (!job || job.userId !== userId) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Job not found',
        });
      }

      const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
      if (!resume || resume.userId !== userId) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Resume not found',
        });
      }

      // Verify that the resume is in PARSED status
      if (resume.status !== 'PARSED') {
        return reply.status(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: `Resume must be in PARSED status to initiate match scoring. Current status: ${resume.status}`,
        });
      }

      // Enqueue match scoring job
      try {
        await matchScoringQueue.add(
          `match-${jobId}-${resumeId}`,
          withTraceContext(request, {
            jobId,
            resumeId,
          }),
          {
            jobId: `match-${jobId}-${resumeId}`,
          }
        );
      } catch (queueErr) {
        request.log.error({ err: queueErr, jobId, resumeId }, 'Failed to enqueue match scoring job');
        return reply.status(503).send({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'Failed to enqueue match scoring task',
        });
      }

      return reply.status(202).send({
        statusCode: 202,
        message: 'Match scoring job enqueued',
        jobId,
        resumeId,
        status: 'QUEUED',
      });
    }
  );

  // -------------------------------------------------------------------------
  // Phase 3B: GET /v1/jobs/:id/matches/:resumeId (Single Match Result Route)
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string; resumeId: string } }>(
    '/v1/jobs/:id/matches/:resumeId',
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const user = request.user as any;
      const userId: string = user.userId || user.sub;
      const { id: jobId, resumeId } = request.params;

      const job = await prisma.job.findUnique({ where: { id: jobId } });
      if (!job || job.userId !== userId) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Job not found',
        });
      }

      const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
      if (!resume || resume.userId !== userId) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Resume not found',
        });
      }

      const match = await prisma.match.findUnique({
        where: {
          resumeId_jobId: {
            resumeId,
            jobId,
          },
        },
      });

      if (!match) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Match result not found',
        });
      }

      return reply.status(200).send({
        id: match.id,
        resumeId: match.resumeId,
        jobId: match.jobId,
        bm25Score: match.bm25Score,
        vectorScore: match.vectorScore,
        rrfScore: match.rrfScore,
        crossEncoderScore: match.crossEncoderScore,
        finalScore: match.finalScore,
        explanation: match.explanation,
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
      });
    }
  );

  // -------------------------------------------------------------------------
  // Phase 4A: POST /v1/jobs/:id/analysis
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/jobs/:id/analysis',
    {
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
      const { id: jobId } = request.params;

      const bodyParse = analysisJobBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: bodyParse.error.errors.map((e) => e.message).join('; '),
        });
      }

      const { resumeId } = bodyParse.data;

      // Verify that BOTH the job and the resume belong to the authenticated user (404 convention)
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      if (!job || job.userId !== userId) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Job not found',
        });
      }

      const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
      if (!resume || resume.userId !== userId) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Resume not found',
        });
      }

      // Verify that the resume is in PARSED status
      if (resume.status !== 'PARSED') {
        return reply.status(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: `Resume must be in PARSED status to initiate structured analysis. Current status: ${resume.status}`,
        });
      }

      // Verify that Match scoring has already completed (409 Conflict if no Match exists)
      const existingMatch = await prisma.match.findUnique({
        where: {
          resumeId_jobId: {
            resumeId,
            jobId,
          },
        },
      });

      if (!existingMatch) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Match scoring must be completed before structured analysis can be generated. Please trigger POST /v1/jobs/:id/match first.',
        });
      }

      // Enqueue analysis job guarded by usage metering
      await withMeter(request, reply, 'analyses', async () => {
        try {
          await analysisQueue.add(
            `analysis-${jobId}-${resumeId}`,
            withTraceContext(request, {
              jobId,
              resumeId,
            }),
            {
              jobId: `analysis-${jobId}-${resumeId}`,
            }
          );
        } catch (queueErr) {
          await usageService.refund(userId, 'analyses', 1);
          request.log.error({ err: queueErr, jobId, resumeId }, 'Failed to enqueue structured analysis job');
          return reply.status(503).send({
            statusCode: 503,
            error: 'Service Unavailable',
            message: 'Failed to enqueue structured analysis task',
          });
        }

        return reply.status(202).send({
          statusCode: 202,
          message: 'Structured analysis job enqueued',
          jobId,
          resumeId,
          status: 'QUEUED',
        });
      });
    }
  );

  // -------------------------------------------------------------------------
  // Phase 4A: GET /v1/jobs/:id/analysis/:resumeId (Single Analysis Result Route)
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string; resumeId: string } }>(
    '/v1/jobs/:id/analysis/:resumeId',
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const user = request.user as any;
      const userId: string = user.userId || user.sub;
      const { id: jobId, resumeId } = request.params;

      const job = await prisma.job.findUnique({ where: { id: jobId } });
      if (!job || job.userId !== userId) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Job not found',
        });
      }

      const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
      if (!resume || resume.userId !== userId) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Resume not found',
        });
      }

      const analysis = await prisma.analysis.findUnique({
        where: {
          resumeId_jobId: {
            resumeId,
            jobId,
          },
        },
      });

      if (!analysis) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Analysis result not found',
        });
      }

      return reply.status(200).send({
        id: analysis.id,
        resumeId: analysis.resumeId,
        jobId: analysis.jobId,
        status: analysis.status,
        llmStatus: analysis.llmStatus,
        score: analysis.score,
        result: analysis.result,
        provider: analysis.provider,
        model: analysis.model,
        promptVersion: analysis.promptVersion,
        tokensPrompt: analysis.tokensPrompt,
        tokensCompletion: analysis.tokensCompletion,
        latencyMs: analysis.latencyMs,
        fabricatedEvidenceRate: analysis.fabricatedEvidenceRate,
        injectionSuspected: analysis.injectionSuspected,
        createdAt: analysis.createdAt,
        updatedAt: analysis.updatedAt,
      });
    }
  );

  // -------------------------------------------------------------------------
  // Phase 8C: GET /v1/jobs (Owner-scoped, paginated, newest first, no raw JD text)
  // -------------------------------------------------------------------------
  const listJobsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  });

  app.get(
    '/v1/jobs',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;
      const userId: string = user.userId || user.sub;

      const parseResult = listJobsQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(422).send({
          type: 'https://api.resumatch.ai/errors/validation-error',
          title: 'Unprocessable Entity',
          status: 422,
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: parseResult.error.errors.map((e) => e.message).join('; '),
          detail: parseResult.error.errors.map((e) => e.message).join('; '),
        });
      }

      const { limit, offset } = parseResult.data;

      const [jobs, total] = await Promise.all([
        prisma.job.findMany({
          where: { userId },
          select: {
            id: true,
            title: true,
            company: true,
            location: true,
            jobType: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.job.count({ where: { userId } }),
      ]);

      return reply.status(200).send({
        jobs,
        total,
        limit,
        offset,
      });
    }
  );

  // -------------------------------------------------------------------------
  // Phase 8C: GET /v1/resumes/:id/matches (Owner-scoped list of matches for resume)
  // -------------------------------------------------------------------------
  const listResumeMatchesParamsSchema = z.object({
    id: z.string().uuid('Invalid resume UUID'),
  });

  app.get<{ Params: { id: string } }>(
    '/v1/resumes/:id/matches',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user as any;
      const userId: string = user.userId || user.sub;

      const paramResult = listResumeMatchesParamsSchema.safeParse(request.params);
      if (!paramResult.success) {
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

      const resumeId = paramResult.data.id;

      // 1. Verify resume ownership (404 on foreign/nonexistent)
      const resume = await prisma.resume.findUnique({
        where: { id: resumeId },
        select: { id: true, userId: true },
      });

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

      const queryResult = listJobsQuerySchema.safeParse(request.query);
      const { limit, offset } = queryResult.success
        ? queryResult.data
        : { limit: 20, offset: 0 };

      // 2. Fetch matches for this resume
      const [matches, total] = await Promise.all([
        prisma.match.findMany({
          where: { resumeId },
          include: {
            job: {
              select: {
                id: true,
                title: true,
                company: true,
                location: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.match.count({ where: { resumeId } }),
      ]);

      // 3. Fetch corresponding analysis records (if any)
      const jobIds = matches.map((m) => m.jobId);
      const analyses = await prisma.analysis.findMany({
        where: {
          resumeId,
          jobId: { in: jobIds },
        },
        select: {
          jobId: true,
          status: true,
          llmStatus: true,
          score: true,
          createdAt: true,
        },
      });

      const analysisMap = new Map<string, (typeof analyses)[number]>();
      for (const a of analyses) {
        if (a.jobId) analysisMap.set(a.jobId, a);
      }

      const results = matches.map((m) => {
        const analysis = analysisMap.get(m.jobId);
        return {
          id: m.id,
          resumeId: m.resumeId,
          jobId: m.jobId,
          job: m.job,
          matchScore: m.finalScore,
          subScores: {
            bm25Score: m.bm25Score,
            vectorScore: m.vectorScore,
            rrfScore: m.rrfScore,
            crossEncoderScore: m.crossEncoderScore,
          },
          explanation: m.explanation,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          analysis: analysis
            ? {
                status: analysis.status,
                llmStatus: analysis.llmStatus,
                score: analysis.score,
                createdAt: analysis.createdAt,
              }
            : null,
        };
      });

      return reply.status(200).send({
        matches: results,
        total,
        limit,
        offset,
      });
    }
  );

  // -------------------------------------------------------------------------
  // Legacy / Unimplemented stubs (Phase 5)
  // -------------------------------------------------------------------------
  const stub501 = async (_req: unknown, reply: FastifyReply) => {
    return reply.status(501).send({
      statusCode: 501,
      error: 'Not Implemented',
      message: 'This job endpoint is not yet implemented. Available in Phase 5.',
    });
  };

  app.all('/jobs', stub501);
  app.all('/jobs/*', stub501);
  app.delete('/v1/jobs/:id', stub501);
};
