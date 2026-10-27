/**
 * Phase 10A - Item B7: Rate Limits and Proxy Trust Tests
 *
 * Verifies that when TRUST_PROXY is false (the secure production default),
 * spoofed / rotating X-Forwarded-For headers CANNOT bypass:
 * 1. Fastify rate limiting on /v1/resumes/upload-url (10 req/min).
 * 2. Auth IP rate limiting via getClientIp().
 *
 * Also verifies getClientIp behavior when TRUST_PROXY is false vs true.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { env } from '../config/env.js';
import { getClientIp } from '../auth/rateLimiter.js';

vi.mock('../db/prisma.js', () => ({
  prisma: {
    resume: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  checkDatabaseHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

vi.mock('../storage/s3.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../storage/s3.js')>();
  return {
    ...original,
    createPresignedUploadUrl: vi.fn(),
    headStorageObject: vi.fn(),
    getStorageObjectByteRange: vi.fn(),
    deleteStorageObject: vi.fn(),
    checkS3Health: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
  };
});

vi.mock('../queues/bullmq.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../queues/bullmq.js')>();
  return {
    ...original,
    resumeParsingQueue: {
      add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
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

import { createPresignedUploadUrl } from '../storage/s3.js';
import { prisma } from '../db/prisma.js';

describe('B7: Rate Limits and Proxy Trust', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(prisma.resume.count).mockResolvedValue(0);
    vi.mocked(createPresignedUploadUrl).mockResolvedValue({
      uploadUrl: 'http://localhost:9000/resumes/key',
      headers: {},
      expiresIn: 300,
    });
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('verifies TRUST_PROXY is false by default in test environment', () => {
    expect(env.TRUST_PROXY).toBe(false);
  });

  it('prevents rate limit bypass via rotating X-Forwarded-For headers on /v1/resumes/upload-url', async () => {
    const token = `Bearer ${app.jwt.sign({ sub: 'attacker-uuid', email: 'attacker@example.com' })}`;

    let hit429 = false;
    let successfulRequests = 0;

    // The route allows 10 req/minute. An attacker rotates X-Forwarded-For across 15 requests
    // trying to spoof 15 distinct client IPs.
    for (let i = 1; i <= 15; i++) {
      const spoofedIp = `203.0.113.${i}`;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resumes/upload-url',
        headers: {
          Authorization: token,
          'X-Forwarded-For': spoofedIp,
        },
        payload: {
          filename: `resume_${i}.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
        },
      });

      if (res.statusCode === 200) {
        successfulRequests++;
      } else if (res.statusCode === 429) {
        hit429 = true;
        const body = JSON.parse(res.body);
        expect(body.message || body.error).toMatch(/rate limit/i);
        break;
      }
    }

    // Because TRUST_PROXY=false, Fastify ignores X-Forwarded-For and tracks the connection IP.
    // Therefore exactly 10 requests are allowed and the 11th is rejected with HTTP 429.
    expect(successfulRequests).toBe(10);
    expect(hit429).toBe(true);
  });

  it('getClientIp ignores X-Forwarded-For when TRUST_PROXY is false', () => {
    const mockRequest = {
      headers: {
        'x-forwarded-for': '198.51.100.99, 10.0.0.1',
      },
      ip: '127.0.0.1',
    } as any;

    const resolvedIp = getClientIp(mockRequest);
    expect(resolvedIp).toBe('127.0.0.1');
  });

  it('getClientIp respects X-Forwarded-For only when TRUST_PROXY is explicitly true', () => {
    const mockRequest = {
      headers: {
        'x-forwarded-for': '198.51.100.99, 10.0.0.1',
      },
      ip: '127.0.0.1',
    } as any;

    const originalTrust = env.TRUST_PROXY;
    try {
      (env as any).TRUST_PROXY = true;
      const resolvedIp = getClientIp(mockRequest);
      expect(resolvedIp).toBe('198.51.100.99');
    } finally {
      (env as any).TRUST_PROXY = originalTrust;
    }
  });
});
