/**
 * Phase 4A: Structured Analysis Route Tests
 *
 * Tests:
 * 1. POST /v1/jobs/:id/analysis:
 *    - 401 unauthenticated
 *    - 404 ownership isolation for Job (user-A vs user-B)
 *    - 404 ownership isolation for Resume (user-A vs user-B)
 *    - 422 resume not in PARSED status
 *    - 409 conflict when Match has not been computed yet
 *    - 202 accepted when valid, enqueuing to analysisQueue
 * 2. GET /v1/jobs/:id/analysis/:resumeId:
 *    - 401 unauthenticated
 *    - 404 ownership isolation
 *    - 404 analysis record not found
 *    - 200 returns full structured analysis result
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../server.js';
import type { FastifyInstance } from 'fastify';

vi.mock('../db/prisma.js', () => ({
  prisma: {
    job: {
      findUnique: vi.fn(),
    },
    resume: {
      findUnique: vi.fn(),
    },
    match: {
      findUnique: vi.fn(),
    },
    analysis: {
      findUnique: vi.fn(),
    },
  },
  checkDatabaseHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

vi.mock('../storage/s3.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../storage/s3.js')>();
  return {
    ...original,
    checkS3Health: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
  };
});

vi.mock('../queues/bullmq.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../queues/bullmq.js')>();
  return {
    ...original,
    analysisQueue: {
      add: vi.fn().mockResolvedValue({ id: 'mock-analysis-job-id' }),
    },
    embeddingQueue: {
      add: vi.fn().mockResolvedValue({ id: 'mock-embed-job-id' }),
    },
    matchScoringQueue: {
      add: vi.fn().mockResolvedValue({ id: 'mock-match-job-id' }),
    },
  };
});

vi.mock('../queues/redis.js', () => ({
  redisClient: {
    quit: vi.fn().mockResolvedValue('OK'),
    status: 'ready',
    ping: vi.fn().mockResolvedValue('PONG'),
    connect: vi.fn().mockResolvedValue(undefined),
  },
  checkRedisHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

import { prisma } from '../db/prisma.js';
import { analysisQueue } from '../queues/bullmq.js';

const mockJobFindUnique = vi.mocked(prisma.job.findUnique);
const mockResumeFindUnique = vi.mocked(prisma.resume.findUnique);
const mockMatchFindUnique = vi.mocked(prisma.match.findUnique);
const mockAnalysisFindUnique = vi.mocked(prisma.analysis.findUnique);
const mockAnalysisQueueAdd = vi.mocked(analysisQueue.add);

async function getAuthToken(
  app: FastifyInstance,
  userId = 'a0000000-0000-0000-0000-000000000001',
  email = 'owner@example.com'
): Promise<string> {
  const token = app.jwt.sign({ sub: userId, email });
  return `Bearer ${token}`;
}

describe('Phase 4A: Structured Analysis Routes', () => {
  let app: FastifyInstance;
  const validJobId = '77777777-7777-4777-a777-777777777777';
  const validResumeId = '88888888-8888-4888-a888-888888888888';

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /v1/jobs/:id/analysis', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/analysis`,
        payload: { resumeId: validResumeId },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when job does not exist or belongs to another user', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/analysis`,
        headers: { authorization: token },
        payload: { resumeId: validResumeId },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).message).toBe('Job not found');
    });

    it('returns 404 when resume does not exist or belongs to another user', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-A',
      } as any);
      mockResumeFindUnique.mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/analysis`,
        headers: { authorization: token },
        payload: { resumeId: validResumeId },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).message).toBe('Resume not found');
    });

    it('returns 422 when resume is not in PARSED status', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-A',
      } as any);
      mockResumeFindUnique.mockResolvedValueOnce({
        id: validResumeId,
        userId: 'user-A',
        status: 'PENDING',
      } as any);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/analysis`,
        headers: { authorization: token },
        payload: { resumeId: validResumeId },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.payload).message).toContain('Resume must be in PARSED status');
    });

    it('returns 409 Conflict when no Match exists yet for this job and resume', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-A',
      } as any);
      mockResumeFindUnique.mockResolvedValueOnce({
        id: validResumeId,
        userId: 'user-A',
        status: 'PARSED',
      } as any);
      mockMatchFindUnique.mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/analysis`,
        headers: { authorization: token },
        payload: { resumeId: validResumeId },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).message).toContain('Match scoring must be completed before structured analysis');
    });

    it('returns 202 and enqueues to analysisQueue when valid', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-A',
      } as any);
      mockResumeFindUnique.mockResolvedValueOnce({
        id: validResumeId,
        userId: 'user-A',
        status: 'PARSED',
      } as any);
      mockMatchFindUnique.mockResolvedValueOnce({
        id: 'match-1',
        jobId: validJobId,
        resumeId: validResumeId,
        finalScore: 82.5,
      } as any);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/analysis`,
        headers: { authorization: token },
        payload: { resumeId: validResumeId },
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('QUEUED');
      expect(body.jobId).toBe(validJobId);
      expect(mockAnalysisQueueAdd).toHaveBeenCalledWith(
        `analysis-${validJobId}-${validResumeId}`,
        {
          jobId: validJobId,
          resumeId: validResumeId,
        },
        expect.objectContaining({
          jobId: `analysis-${validJobId}-${validResumeId}`,
        }),
      );
    });
  });

  describe('GET /v1/jobs/:id/analysis/:resumeId', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${validJobId}/analysis/${validResumeId}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when analysis does not exist', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-A',
      } as any);
      mockResumeFindUnique.mockResolvedValueOnce({
        id: validResumeId,
        userId: 'user-A',
      } as any);
      mockAnalysisFindUnique.mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${validJobId}/analysis/${validResumeId}`,
        headers: { authorization: token },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).message).toBe('Analysis result not found');
    });

    it('returns 200 with full analysis payload when found', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-A',
      } as any);
      mockResumeFindUnique.mockResolvedValueOnce({
        id: validResumeId,
        userId: 'user-A',
      } as any);
      mockAnalysisFindUnique.mockResolvedValueOnce({
        id: 'analysis-123',
        jobId: validJobId,
        resumeId: validResumeId,
        status: 'COMPLETED',
        llmStatus: 'SUCCESS',
        score: 83.39,
        result: {
          summary: 'Candidate shows strong backend background.',
          strengths: [
            {
              point: 'Extensive TypeScript knowledge',
              requirement: 'TypeScript',
              evidenceQuote: 'Built microservices in TypeScript',
              startChar: 10,
              endChar: 41,
            },
          ],
          gaps: [],
          prioritizedImprovements: [],
          matchScore: 83.39,
          atsScore: 92.0,
          verdictBand: 'strong',
          matchedSkills: ['TypeScript', 'Node.js'],
          missingSkills: [],
          partialSkills: [],
          llmStatus: 'SUCCESS',
        },
      } as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${validJobId}/analysis/${validResumeId}`,
        headers: { authorization: token },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe('analysis-123');
      expect(body.llmStatus).toBe('SUCCESS');
      expect(body.result.matchScore).toBe(83.39);
      expect(body.result.verdictBand).toBe('strong');
    });
  });
});
