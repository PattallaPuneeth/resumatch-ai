/**
 * Phase 4C: Resume Improvements & Role Suggestions Route Tests
 *
 * Tests:
 * 1. POST /v1/resumes/:resumeId/improvements:
 *    - 401 unauthenticated
 *    - 404 IDOR ownership check on resume
 *    - 404 resume not found
 *    - 422 resume not in PARSED status
 *    - 422 parsed resume text is missing or empty
 *    - 200 success with deterministic findings and ML-ranked roles
 *    - 503 when ML service is unavailable
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../server.js';
import type { FastifyInstance } from 'fastify';

vi.mock('../db/prisma.js', () => ({
  prisma: {
    resume: {
      findUnique: vi.fn(),
    },
    parsedResume: {
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

const mockResumeFindUnique = vi.mocked(prisma.resume.findUnique);
const mockParsedResumeFindUnique = vi.mocked(prisma.parsedResume.findUnique);

async function getAuthToken(
  app: FastifyInstance,
  userId = 'a0000000-0000-0000-0000-000000000001',
  email = 'owner@example.com'
): Promise<string> {
  const token = app.jwt.sign({ sub: userId, email });
  return `Bearer ${token}`;
}

describe('Phase 4C: Resume Improvements & Role Suggestions Routes', () => {
  let app: FastifyInstance;
  const ownerId = 'a0000000-0000-0000-0000-000000000001';
  const otherUserId = 'b0000000-0000-0000-0000-000000000002';
  const validResumeId = '88888888-8888-4888-a888-888888888888';

  const sampleRawText =
    'Jane Doe\nSoftware Engineer\nExperience:\n- Developed microservices with FastAPI and PostgreSQL.\nSkills: Python, Docker, Redis.\nEducation: BS CS';

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('returns 401 when no authorization token is provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/resumes/${validResumeId}/improvements`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when resume belongs to another user (IDOR prevention)', async () => {
    const token = await getAuthToken(app, ownerId);
    mockResumeFindUnique.mockResolvedValueOnce({
      id: validResumeId,
      userId: otherUserId,
      status: 'PARSED',
    } as any);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/resumes/${validResumeId}/improvements`,
      headers: { authorization: token },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.message).toBe('Resume not found');
  });

  it('returns 404 when resume does not exist', async () => {
    const token = await getAuthToken(app, ownerId);
    mockResumeFindUnique.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/resumes/${validResumeId}/improvements`,
      headers: { authorization: token },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 422 when resume is not in PARSED status', async () => {
    const token = await getAuthToken(app, ownerId);
    mockResumeFindUnique.mockResolvedValueOnce({
      id: validResumeId,
      userId: ownerId,
      status: 'PROCESSING',
    } as any);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/resumes/${validResumeId}/improvements`,
      headers: { authorization: token },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.message).toContain('PARSED status');
  });

  it('returns 422 when parsed resume text is missing or empty', async () => {
    const token = await getAuthToken(app, ownerId);
    mockResumeFindUnique.mockResolvedValueOnce({
      id: validResumeId,
      userId: ownerId,
      status: 'PARSED',
    } as any);
    mockParsedResumeFindUnique.mockResolvedValueOnce({
      resumeId: validResumeId,
      rawText: '',
    } as any);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/resumes/${validResumeId}/improvements`,
      headers: { authorization: token },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.message).toContain('Parsed resume text is missing');
  });

  it('returns 200 with improvements and role suggestions on success', async () => {
    const token = await getAuthToken(app, ownerId);
    mockResumeFindUnique.mockResolvedValueOnce({
      id: validResumeId,
      userId: ownerId,
      status: 'PARSED',
    } as any);
    mockParsedResumeFindUnique.mockResolvedValueOnce({
      resumeId: validResumeId,
      rawText: sampleRawText,
      atsScore: 92.0,
      atsHazards: [],
      skills: ['Python', 'Docker'],
    } as any);

    const mockMlResponse = {
      atsScore: 92.0,
      atsFixes: [],
      contentFindings: [
        {
          type: 'NO_METRIC_OR_NUMBER',
          severity: 'LOW',
          message: 'Bullet lacks numbers or metrics.',
          startChar: 40,
          endChar: 95,
          quote: 'Developed microservices with FastAPI and PostgreSQL.',
        },
      ],
      suggestedRoles: [
        {
          title: 'Backend Engineer',
          similarityScore: 0.88,
          matchedSkills: ['python', 'fastapi'],
          missingSkills: ['kubernetes'],
        },
      ],
      explanation: {
        summary: 'Solid backend engineer profile.',
        prioritizedNextSteps: ['Add measurable latency or throughput numbers.'],
      },
      llmStatus: 'SUCCESS',
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      tokensPrompt: 140,
      tokensCompletion: 45,
      latencyMs: 310,
    };

    const globalFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce(mockMlResponse),
    });
    vi.stubGlobal('fetch', globalFetch);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/resumes/${validResumeId}/improvements`,
      headers: { authorization: token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.atsScore).toBe(92.0);
    expect(body.suggestedRoles).toHaveLength(1);
    expect(body.suggestedRoles[0].title).toBe('Backend Engineer');
    expect(body.contentFindings).toHaveLength(1);
    expect(body.llmStatus).toBe('SUCCESS');
    expect(body.explanation.summary).toBe('Solid backend engineer profile.');

    // Verify ML call had internal token header
    expect(globalFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/resumes/${validResumeId}/improvements`),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Internal-Token': expect.any(String),
        }),
      })
    );

    vi.unstubAllGlobals();
  });

  it('returns 503 when ML improvements service is unreachable', async () => {
    const token = await getAuthToken(app, ownerId);
    mockResumeFindUnique.mockResolvedValueOnce({
      id: validResumeId,
      userId: ownerId,
      status: 'PARSED',
    } as any);
    mockParsedResumeFindUnique.mockResolvedValueOnce({
      resumeId: validResumeId,
      rawText: sampleRawText,
      atsScore: 92.0,
      atsHazards: [],
    } as any);

    const globalFetch = vi.fn().mockRejectedValueOnce(new Error('Connection refused'));
    vi.stubGlobal('fetch', globalFetch);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/resumes/${validResumeId}/improvements`,
      headers: { authorization: token },
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.message).toContain('ML improvements service is currently unavailable');

    vi.unstubAllGlobals();
  });
});
