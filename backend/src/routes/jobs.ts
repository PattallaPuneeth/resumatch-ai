import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { embeddingQueue, matchScoringQueue } from '../queues/bullmq.js';

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
          max: 20,
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
          {
            type: 'EMBED_DOCUMENT',
            entityType: 'JOB',
            entityId: job.id,
            jobId: job.id,
          },
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
          max: 20,
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
          {
            jobId,
            resumeId,
          },
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
  app.get('/v1/jobs', stub501);
};
