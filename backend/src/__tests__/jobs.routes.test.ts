/**
 * Phase 3B: Job Management and Matching Route Tests
 *
 * Tests:
 * 1. POST /v1/jobs: Auth, validation, persistence, and embedding queueing
 * 2. GET /v1/jobs/:id: Auth, ownership isolation (404), chunkCount
 * 3. POST /v1/jobs/:id/match: Auth, dual-ownership (404), resume PARSED check (422), match-scoring queueing
 * 4. GET /v1/jobs/:id/matches/:resumeId: Auth, ownership (404), match record retrieval
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../server.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../db/prisma.js', () => ({
  prisma: {
    job: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    resume: {
      findUnique: vi.fn(),
    },
    match: {
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
  createRedisClient: vi.fn(),
}));

vi.mock('../storage/minio.js', () => ({
  checkMinioHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

// ---------------------------------------------------------------------------
// Helpers and Mock References
// ---------------------------------------------------------------------------
import { embeddingQueue, matchScoringQueue } from '../queues/bullmq.js';
import { prisma } from '../db/prisma.js';

const mockEmbeddingQueueAdd = vi.mocked(embeddingQueue.add);
const mockMatchScoringQueueAdd = vi.mocked(matchScoringQueue.add);
const mockJobCreate = vi.mocked(prisma.job.create);
const mockJobFindUnique = vi.mocked(prisma.job.findUnique);
const mockResumeFindUnique = vi.mocked(prisma.resume.findUnique);
const mockMatchFindUnique = vi.mocked(prisma.match.findUnique);

async function getAuthToken(
  app: FastifyInstance,
  userId = 'a0000000-0000-0000-0000-000000000001',
  email = 'owner@example.com'
) {
  const token = app.jwt.sign({ sub: userId, email });
  return `Bearer ${token}`;
}

describe('Phase 3B: Job & Matching Routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // =========================================================================
  // 1. POST /v1/jobs
  // =========================================================================
  describe('POST /v1/jobs', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs',
        payload: {
          title: 'Senior Backend Engineer',
          company: 'Acme Corp',
          rawDescription: 'Looking for a Senior Backend Engineer with TypeScript, Node.js, and Postgres experience.',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 422 when required fields are missing', async () => {
      const token = await getAuthToken(app);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs',
        headers: { authorization: token },
        payload: {
          company: 'Acme Corp',
          // missing title and rawDescription
        },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Unprocessable Entity');
    });

    it('returns 201, persists job, and enqueues embedding task', async () => {
      const token = await getAuthToken(app, 'a0000000-0000-0000-0000-000000000001');

      const mockCreatedJob = {
        id: 'b1111111-1111-1111-1111-111111111111',
        userId: 'a0000000-0000-0000-0000-000000000001',
        title: 'Senior Backend Engineer',
        company: 'Acme Corp',
        location: 'Remote',
        jobType: 'FULL_TIME',
        rawDescription: 'Looking for a Senior Backend Engineer with TypeScript, Node.js, and Postgres experience.',
        requiredSkills: ['TypeScript', 'Node.js', 'PostgreSQL'],
        preferredSkills: ['Docker', 'AWS'],
        experienceLevel: 'SENIOR',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockJobCreate.mockResolvedValueOnce(mockCreatedJob as any);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs',
        headers: { authorization: token },
        payload: {
          title: 'Senior Backend Engineer',
          company: 'Acme Corp',
          location: 'Remote',
          jobType: 'FULL_TIME',
          rawDescription: 'Looking for a Senior Backend Engineer with TypeScript, Node.js, and Postgres experience.',
          requiredSkills: ['TypeScript', 'Node.js', 'PostgreSQL'],
          preferredSkills: ['Docker', 'AWS'],
          experienceLevel: 'SENIOR',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe(mockCreatedJob.id);
      expect(body.title).toBe('Senior Backend Engineer');
      expect(body.status).toBe('ACTIVE');

      expect(mockJobCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'a0000000-0000-0000-0000-000000000001',
            title: 'Senior Backend Engineer',
            company: 'Acme Corp',
          }),
        })
      );

      expect(mockEmbeddingQueueAdd).toHaveBeenCalledWith(
        'embed-job-b1111111-1111-1111-1111-111111111111',
        {
          type: 'EMBED_DOCUMENT',
          entityType: 'JOB',
          entityId: 'b1111111-1111-1111-1111-111111111111',
          jobId: 'b1111111-1111-1111-1111-111111111111',
        },
        {
          jobId: 'embed-job-b1111111-1111-1111-1111-111111111111',
        }
      );
    });
  });

  // =========================================================================
  // 2. GET /v1/jobs/:id
  // =========================================================================
  describe('GET /v1/jobs/:id', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/jobs/b1111111-1111-1111-1111-111111111111',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when job does not exist', async () => {
      const token = await getAuthToken(app);
      mockJobFindUnique.mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/jobs/b1111111-1111-1111-1111-111111111111',
        headers: { authorization: token },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).message).toBe('Job not found');
    });

    it('returns 404 when job belongs to another user (tenant isolation)', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: 'b1111111-1111-1111-1111-111111111111',
        userId: 'user-B', // Different user!
        title: 'Backend Engineer',
        _count: { chunks: 4 },
      } as any);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/jobs/b1111111-1111-1111-1111-111111111111',
        headers: { authorization: token },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).message).toBe('Job not found');
    });

    it('returns 200 with job details and chunkCount for owner', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: 'b1111111-1111-1111-1111-111111111111',
        userId: 'user-A',
        title: 'Backend Engineer',
        company: 'Acme Corp',
        location: 'Remote',
        jobType: 'FULL_TIME',
        rawDescription: 'Desc',
        requiredSkills: ['Node'],
        preferredSkills: [],
        experienceLevel: 'MID',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { chunks: 3 },
      } as any);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/jobs/b1111111-1111-1111-1111-111111111111',
        headers: { authorization: token },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe('b1111111-1111-1111-1111-111111111111');
      expect(body.chunkCount).toBe(3);
    });
  });

  // =========================================================================
  // 3. POST /v1/jobs/:id/match
  // =========================================================================
  describe('POST /v1/jobs/:id/match', () => {
    const validJobId = 'b1111111-1111-1111-1111-111111111111';
    const validResumeId = 'c2222222-2222-2222-2222-222222222222';

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/match`,
        payload: { resumeId: validResumeId },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 422 when resumeId is missing or invalid format', async () => {
      const token = await getAuthToken(app);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/match`,
        headers: { authorization: token },
        payload: { resumeId: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('returns 404 when job does not belong to user', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-B',
      } as any);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/match`,
        headers: { authorization: token },
        payload: { resumeId: validResumeId },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).message).toBe('Job not found');
    });

    it('returns 404 when resume does not belong to user', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-A',
      } as any);
      mockResumeFindUnique.mockResolvedValueOnce({
        id: validResumeId,
        userId: 'user-B', // Different owner!
        status: 'PARSED',
      } as any);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/match`,
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
        status: 'PROCESSING', // Not PARSED!
      } as any);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/match`,
        headers: { authorization: token },
        payload: { resumeId: validResumeId },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.payload);
      expect(body.message).toContain('Resume must be in PARSED status');
    });

    it('returns 202 and enqueues match-scoring task on valid request', async () => {
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

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${validJobId}/match`,
        headers: { authorization: token },
        payload: { resumeId: validResumeId },
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('QUEUED');
      expect(body.jobId).toBe(validJobId);
      expect(body.resumeId).toBe(validResumeId);

      expect(mockMatchScoringQueueAdd).toHaveBeenCalledWith(
        `match-${validJobId}-${validResumeId}`,
        {
          jobId: validJobId,
          resumeId: validResumeId,
        },
        {
          jobId: `match-${validJobId}-${validResumeId}`,
        }
      );
    });
  });

  // =========================================================================
  // 4. GET /v1/jobs/:id/matches/:resumeId
  // =========================================================================
  describe('GET /v1/jobs/:id/matches/:resumeId', () => {
    const validJobId = 'b1111111-1111-1111-1111-111111111111';
    const validResumeId = 'c2222222-2222-2222-2222-222222222222';

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${validJobId}/matches/${validResumeId}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when job does not belong to user', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-B',
      } as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${validJobId}/matches/${validResumeId}`,
        headers: { authorization: token },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).message).toBe('Job not found');
    });

    it('returns 404 when match record does not exist yet', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-A',
      } as any);
      mockResumeFindUnique.mockResolvedValueOnce({
        id: validResumeId,
        userId: 'user-A',
      } as any);
      mockMatchFindUnique.mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${validJobId}/matches/${validResumeId}`,
        headers: { authorization: token },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).message).toBe('Match result not found');
    });

    it('returns 200 with match record, scores, and details', async () => {
      const token = await getAuthToken(app, 'user-A');
      mockJobFindUnique.mockResolvedValueOnce({
        id: validJobId,
        userId: 'user-A',
      } as any);
      mockResumeFindUnique.mockResolvedValueOnce({
        id: validResumeId,
        userId: 'user-A',
      } as any);
      mockMatchFindUnique.mockResolvedValueOnce({
        id: 'match-123',
        jobId: validJobId,
        resumeId: validResumeId,
        userId: 'user-A',
        overallScore: 84.5,
        lexicalScore: 0.72,
        semanticScore: 0.88,
        rrfScore: 0.031,
        crossEncoderScore: 84.5,
        finalScore: 84.5,
        status: 'COMPLETED',
        explanation: {
          skillGap: {
            matched: ['TypeScript', 'Node.js'],
            partial: [],
            missing: ['PostgreSQL'],
            coverageRatio: 0.67,
          },
        },
        matchDetails: [
          {
            id: 'detail-1',
            matchId: 'match-123',
            resumeChunkId: 'rc-1',
            jobChunkId: 'jc-1',
            lexicalRank: 1,
            semanticRank: 2,
            rrfScore: 0.031,
            rerankScore: 85.0,
            similarity: 0.88,
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${validJobId}/matches/${validResumeId}`,
        headers: { authorization: token },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe('match-123');
      expect(body.explanation.skillGap.matched).toContain('TypeScript');
      expect(body.explanation.skillGap.missing).toContain('PostgreSQL');
    });
  });
});
