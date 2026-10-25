/**
 * Phase 4B: STAR Bullet Rewriter Route Tests
 *
 * Tests:
 * 1. POST /v1/rewriter/bullet:
 *    - 401 unauthenticated
 *    - 404 IDOR ownership check on resume
 *    - 404 IDOR ownership check on job
 *    - 422 resume not in PARSED status
 *    - 422 bullet not an exact substring of ParsedResume.rawText
 *    - 422 bullet exceeds 500 characters
 *    - 422 HALLUCINATION_DETECTED path (RFC 7807 format)
 *    - 200 success with verified STAR options
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

const mockJobFindUnique = vi.mocked(prisma.job.findUnique);
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

describe('Phase 4B: Fact-Grounded STAR Bullet Rewriter Routes', () => {
  let app: FastifyInstance;
  const ownerId = 'a0000000-0000-0000-0000-000000000001';
  const otherUserId = 'b0000000-0000-0000-0000-000000000002';
  const validResumeId = '88888888-8888-4888-a888-888888888888';
  const validJobId = '77777777-7777-4777-a777-777777777777';

  const sampleBullet = 'Refactored backend microservices using Python and Docker.';
  const sampleRawText = `Jane Doe\nSoftware Engineer\nExperience:\n- ${sampleBullet}\nSkills: Python, Docker, Redis.`;

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
      url: '/v1/rewriter/bullet',
      payload: {
        resumeId: validResumeId,
        originalBullet: sampleBullet,
      },
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
      url: '/v1/rewriter/bullet',
      headers: { authorization: token },
      payload: {
        resumeId: validResumeId,
        originalBullet: sampleBullet,
      },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.message).toBe('Resume not found');
  });

  it('returns 404 when jobId belongs to another user (IDOR prevention)', async () => {
    const token = await getAuthToken(app, ownerId);
    mockResumeFindUnique.mockResolvedValueOnce({
      id: validResumeId,
      userId: ownerId,
      status: 'PARSED',
    } as any);
    mockParsedResumeFindUnique.mockResolvedValueOnce({
      resumeId: validResumeId,
      rawText: sampleRawText,
    } as any);
    mockJobFindUnique.mockResolvedValueOnce({
      id: validJobId,
      userId: otherUserId, // Different user
    } as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/rewriter/bullet',
      headers: { authorization: token },
      payload: {
        resumeId: validResumeId,
        originalBullet: sampleBullet,
        jobId: validJobId,
      },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.message).toBe('Job not found');
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
      url: '/v1/rewriter/bullet',
      headers: { authorization: token },
      payload: {
        resumeId: validResumeId,
        originalBullet: sampleBullet,
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.message).toContain('PARSED status');
  });

  it('returns 422 when originalBullet is not an exact substring of ParsedResume.rawText', async () => {
    const token = await getAuthToken(app, ownerId);
    mockResumeFindUnique.mockResolvedValueOnce({
      id: validResumeId,
      userId: ownerId,
      status: 'PARSED',
    } as any);
    mockParsedResumeFindUnique.mockResolvedValueOnce({
      resumeId: validResumeId,
      rawText: sampleRawText,
    } as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/rewriter/bullet',
      headers: { authorization: token },
      payload: {
        resumeId: validResumeId,
        originalBullet: 'Fabricated bullet not present anywhere in rawText',
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.message).toContain('exact substring of ParsedResume.rawText');
  });

  it('returns 422 when originalBullet exceeds 500 characters', async () => {
    const token = await getAuthToken(app, ownerId);
    const oversizeBullet = 'X'.repeat(501);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/rewriter/bullet',
      headers: { authorization: token },
      payload: {
        resumeId: validResumeId,
        originalBullet: oversizeBullet,
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.message).toContain('exceed 500 characters');
  });

  it('returns 422 with RFC 7807 problem details when ML service returns HALLUCINATION_DETECTED', async () => {
    const token = await getAuthToken(app, ownerId);
    mockResumeFindUnique.mockResolvedValueOnce({
      id: validResumeId,
      userId: ownerId,
      status: 'PARSED',
    } as any);
    mockParsedResumeFindUnique.mockResolvedValueOnce({
      resumeId: validResumeId,
      rawText: sampleRawText,
    } as any);

    // Mock global fetch to simulate ML service returning 422 hallucination detected
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      status: 422,
      ok: false,
      json: async () => ({
        detail: 'HALLUCINATION_DETECTED: No rewritten options could be verified against source facts.',
      }),
    } as any);

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/rewriter/bullet',
        headers: { authorization: token },
        payload: {
          resumeId: validResumeId,
          originalBullet: sampleBullet,
        },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.type).toBe('https://api.resumatch.ai/errors/hallucination-detected');
      expect(body.title).toBe('Hallucination Detected');
      expect(body.status).toBe(422);
      expect(body.message).toContain('HALLUCINATION_DETECTED');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns 200 with verified STAR options on successful rewrite', async () => {
    const token = await getAuthToken(app, ownerId);
    mockResumeFindUnique.mockResolvedValueOnce({
      id: validResumeId,
      userId: ownerId,
      status: 'PARSED',
    } as any);
    mockParsedResumeFindUnique.mockResolvedValueOnce({
      resumeId: validResumeId,
      rawText: sampleRawText,
    } as any);

    const mockMlResponse = {
      status: 'SUCCESS',
      originalBullet: sampleBullet,
      options: [
        {
          text: 'Refactored Python backend microservices using Docker containers, reducing deploy latency by [add metric].',
          evidenceSpans: [
            {
              startChar: 45,
              endChar: 45 + sampleBullet.length,
              quote: sampleBullet,
            },
          ],
          needsUserInput: true,
        },
      ],
      provider: 'mock-groq',
      model: 'openai/gpt-oss-120b',
      tokensPrompt: 110,
      tokensCompletion: 55,
      latencyMs: 140,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => mockMlResponse,
    } as any);

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/rewriter/bullet',
        headers: { authorization: token },
        payload: {
          resumeId: validResumeId,
          originalBullet: sampleBullet,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('SUCCESS');
      expect(body.options).toHaveLength(1);
      expect(body.options[0].needsUserInput).toBe(true);
      expect(body.options[0].text).toContain('[add metric]');
      expect(body.options[0].evidenceSpans[0].quote).toBe(sampleBullet);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
