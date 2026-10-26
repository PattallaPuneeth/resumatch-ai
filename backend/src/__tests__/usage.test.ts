import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import {
  UsageService,
  usageService,
  calculateThresholds,
  getCurrentPeriodUtc,
} from '../services/usageService.js';
import {
  createTestUserAndSession,
  cleanupTestUser,
  type TestAuthSession,
} from './testAuthHelper.js';
import { analysisQueue } from '../queues/bullmq.js';
import * as storageModule from '../storage/s3.js';
import { cleanupStaleUploadPending } from '../services/cleanupService.js';

describe('Phase 6: Usage Metering, Displayed Limits, and Alerts Suite', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // 1. Threshold Calculation (Integer Math: used * 100 >= limit * T)
  // ---------------------------------------------------------------------------
  describe('Threshold Calculation Invariants', () => {
    it('returns unlimited defaults when limit is null or negative', () => {
      const res = calculateThresholds(100, null);
      expect(res.unlimited).toBe(true);
      expect(res.percent).toBeNull();
      expect(res.activeThreshold).toBeNull();
      expect(res.crossedThresholds).toEqual([]);
      expect(res.blocked).toBe(false);
    });

    it('calculates 49% as below first threshold (activeThreshold null)', () => {
      const res = calculateThresholds(49, 100);
      expect(res.unlimited).toBe(false);
      expect(res.percent).toBe(49);
      expect(res.activeThreshold).toBeNull();
      expect(res.crossedThresholds).toEqual([]);
      expect(res.blocked).toBe(false);
    });

    it('calculates 50% threshold boundary correctly', () => {
      const res = calculateThresholds(50, 100);
      expect(res.unlimited).toBe(false);
      expect(res.percent).toBe(50);
      expect(res.activeThreshold).toBe(50);
      expect(res.crossedThresholds).toEqual([50]);
      expect(res.blocked).toBe(false);
    });

    it('calculates 70% threshold boundary correctly', () => {
      const res = calculateThresholds(70, 100);
      expect(res.unlimited).toBe(false);
      expect(res.percent).toBe(70);
      expect(res.activeThreshold).toBe(70);
      expect(res.crossedThresholds).toEqual([50, 70]);
      expect(res.blocked).toBe(false);
    });

    it('calculates 90% threshold boundary correctly', () => {
      const res = calculateThresholds(90, 100);
      expect(res.unlimited).toBe(false);
      expect(res.percent).toBe(90);
      expect(res.activeThreshold).toBe(90);
      expect(res.crossedThresholds).toEqual([50, 70, 90]);
      expect(res.blocked).toBe(false);
    });

    it('calculates 100% threshold boundary and blocks action', () => {
      const res = calculateThresholds(100, 100);
      expect(res.unlimited).toBe(false);
      expect(res.percent).toBe(100);
      expect(res.activeThreshold).toBe(100);
      expect(res.crossedThresholds).toEqual([50, 70, 90, 100]);
      expect(res.blocked).toBe(true);
    });

    it('verifies integer math on small limit (limit = 3)', () => {
      // 1 / 3: 100 < 150 -> no threshold
      const res1 = calculateThresholds(1, 3);
      expect(res1.activeThreshold).toBeNull();
      expect(res1.blocked).toBe(false);

      // 2 / 3: 200 >= 150 (50 crossed), 200 < 210 (70 not crossed)
      const res2 = calculateThresholds(2, 3);
      expect(res2.activeThreshold).toBe(50);
      expect(res2.crossedThresholds).toEqual([50]);
      expect(res2.blocked).toBe(false);

      // 3 / 3: 300 >= 150, 210, 270, 300 -> all crossed, blocked = true
      const res3 = calculateThresholds(3, 3);
      expect(res3.activeThreshold).toBe(100);
      expect(res3.crossedThresholds).toEqual([50, 70, 90, 100]);
      expect(res3.blocked).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Concurrency & Race-Safe Consumption
  // ---------------------------------------------------------------------------
  describe('Concurrency & Atomic Consumption', () => {
    let session: TestAuthSession;

    beforeEach(async () => {
      session = await createTestUserAndSession(app, { username: `concurrent_user_${Date.now()}` });
      // Set to demo plan with analyses limit = 10
      await prisma.user.update({
        where: { id: session.userId },
        data: { planKey: 'demo' },
      });
    });

    afterEach(async () => {
      if (session?.userId) {
        await cleanupTestUser(session.userId);
      }
    });

    it('handles N parallel requests against limit M: exactly M succeed and N-M fail with 429', async () => {
      const limit = 10;
      const parallelRequests = 25;

      // Launch 25 concurrent consume requests against limit of 10
      const consumePromises = Array.from({ length: parallelRequests }, () =>
        usageService.consume(session.userId, 'analyses', 1)
      );

      const results = await Promise.all(consumePromises);

      const succeeded = results.filter((r) => r.allowed);
      const blocked = results.filter((r) => !r.allowed);

      expect(succeeded.length).toBe(limit);
      expect(blocked.length).toBe(parallelRequests - limit);

      // Verify the persisted counter in DB is exactly the limit
      const currentPeriod = getCurrentPeriodUtc(new Date());
      const usageRow = await prisma.userUsage.findUnique({
        where: {
          userId_meter_period: {
            userId: session.userId,
            meter: 'analyses',
            period: currentPeriod,
          },
        },
      });

      expect(Number(usageRow?.used)).toBe(limit);
    });

    it('handles concurrent requests for job_suggestions quota: fires 10 in parallel against limit 5, exactly 5 succeed and 5 fail', async () => {
      // Demo plan has job_suggestions limit = 5
      const limit = 5;
      const parallelRequests = 10;

      const consumePromises = Array.from({ length: parallelRequests }, () =>
        usageService.consume(session.userId, 'job_suggestions', 1)
      );

      const results = await Promise.all(consumePromises);

      const succeeded = results.filter((r) => r.allowed);
      const blocked = results.filter((r) => !r.allowed);

      expect(succeeded.length).toBe(limit);
      expect(blocked.length).toBe(parallelRequests - limit);

      // Verify the persisted counter in DB is exactly the limit
      const currentPeriod = getCurrentPeriodUtc(new Date());
      const usageRow = await prisma.userUsage.findUnique({
        where: {
          userId_meter_period: {
            userId: session.userId,
            meter: 'job_suggestions',
            period: currentPeriod,
          },
        },
      });

      expect(Number(usageRow?.used)).toBe(limit);
    });

    it('rejects invalid, negative, float or enormous consumption amounts without side effects', async () => {
      await expect(usageService.consume(session.userId, 'analyses', -1)).rejects.toThrow('Invalid consumption amount');
      await expect(usageService.consume(session.userId, 'analyses', 0)).rejects.toThrow('Invalid consumption amount');
      await expect(usageService.consume(session.userId, 'analyses', 1.5)).rejects.toThrow('Invalid consumption amount');
      await expect(usageService.consume(session.userId, 'analyses', 10_000_000_000_000)).rejects.toThrow('Invalid consumption amount');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Period Rollover via Injected Clock
  // ---------------------------------------------------------------------------
  describe('Period Rollover via Injected Clock', () => {
    it('rolls over monthly counters cleanly when month changes without cron dependency', async () => {
      let simulatedDate = new Date(Date.UTC(2026, 9, 26, 12, 0, 0)); // Oct 26, 2026
      const clockedUsageService = new UsageService(() => simulatedDate);

      const testUser = await prisma.user.create({
        data: {
          role: 'CANDIDATE',
          planKey: 'demo', // analyses: 10
        },
      });

      try {
        // Oct 2026: Consume 8 units
        for (let i = 0; i < 8; i++) {
          const res = await clockedUsageService.consume(testUser.id, 'analyses', 1);
          expect(res.allowed).toBe(true);
        }

        const octUsage = await clockedUsageService.getUsage(testUser.id);
        expect(octUsage.period).toBe('2026-10');
        expect(octUsage.meters.analyses.used).toBe(8);
        expect(octUsage.meters.analyses.percent).toBe(80);
        expect(octUsage.meters.analyses.activeThreshold).toBe(70);

        // Advance injected clock to Nov 1, 2026 00:00:05 UTC (Next Month)
        simulatedDate = new Date(Date.UTC(2026, 10, 1, 0, 0, 5));

        const novUsage = await clockedUsageService.getUsage(testUser.id);
        expect(novUsage.period).toBe('2026-11');
        // Rolled over: November starts at 0 used!
        expect(novUsage.meters.analyses.used).toBe(0);
        expect(novUsage.meters.analyses.percent).toBe(0);
        expect(novUsage.meters.analyses.activeThreshold).toBeNull();
        expect(novUsage.meters.analyses.blocked).toBe(false);

        // Historical October record is safely preserved in DB
        const octRecord = await prisma.userUsage.findUnique({
          where: {
            userId_meter_period: {
              userId: testUser.id,
              meter: 'analyses',
              period: '2026-10',
            },
          },
        });
        expect(Number(octRecord?.used)).toBe(8);
      } finally {
        await cleanupTestUser(testUser.id);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Unlimited Plan Behavior
  // ---------------------------------------------------------------------------
  describe('Unlimited Plan (Default)', () => {
    let session: TestAuthSession;

    beforeAll(async () => {
      session = await createTestUserAndSession(app, { username: `unlimited_user_${Date.now()}` });
    });

    afterAll(async () => {
      if (session?.userId) {
        await cleanupTestUser(session.userId);
      }
    });

    it('new users default to unlimited plan with null limits', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: session.authHeader,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');

      const body = res.json();
      expect(body.plan).toBe('unlimited');
      expect(body.meters.analyses.limit).toBeNull();
      expect(body.meters.analyses.unlimited).toBe(true);
      expect(body.meters.analyses.percent).toBeNull();
      expect(body.meters.analyses.blocked).toBe(false);

      expect(body.meters.job_suggestions.limit).toBeNull();
      expect(body.meters.job_suggestions.unlimited).toBe(true);

      expect(body.meters.resume_storage_bytes.limit).toBeNull();
      expect(body.meters.resume_storage_bytes.unlimited).toBe(true);
      expect(body.meters.resume_storage_bytes.resetAt).toBeNull();
    });

    it('unlimited plan never blocks consumption even with high volume', async () => {
      for (let i = 0; i < 20; i++) {
        const result = await usageService.consume(session.userId, 'analyses', 1);
        expect(result.allowed).toBe(true);
        expect(result.limit).toBeNull();
      }

      const res = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: session.authHeader,
      });

      const body = res.json();
      expect(body.meters.analyses.used).toBe(20);
      expect(body.meters.analyses.unlimited).toBe(true);
      expect(body.meters.analyses.blocked).toBe(false);
    });

    it('50/70/90 alerts for job_suggestions appear in GET /v1/usage as activeThreshold after crossing', async () => {
      // Create a dedicated plan with job_suggestions limit = 10 for clean percentage thresholds
      const planKey = `tier_test_plan_${Date.now()}`;
      await prisma.plan.create({
        data: {
          key: planKey,
          name: 'Tier Test Plan',
          limits: { analyses: 10, job_suggestions: 10, resume_storage_bytes: 10485760 },
        },
      });

      await prisma.user.update({
        where: { id: session.userId },
        data: { planKey },
      });

      // 1. Initial state (0% used)
      let res = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: session.authHeader,
      });
      let body = res.json();
      expect(body.meters.job_suggestions.used).toBe(0);
      expect(body.meters.job_suggestions.limit).toBe(10);
      expect(body.meters.job_suggestions.activeThreshold).toBeNull();
      expect(body.meters.job_suggestions.crossedThresholds).toEqual([]);

      // 2. Consume 4 units (40% used -> below 50%)
      await usageService.consume(session.userId, 'job_suggestions', 4);
      res = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: session.authHeader,
      });
      body = res.json();
      expect(body.meters.job_suggestions.used).toBe(4);
      expect(body.meters.job_suggestions.activeThreshold).toBeNull();
      expect(body.meters.job_suggestions.crossedThresholds).toEqual([]);

      // 3. Consume 1 unit (50% used -> crosses 50 threshold)
      await usageService.consume(session.userId, 'job_suggestions', 1);
      res = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: session.authHeader,
      });
      body = res.json();
      expect(body.meters.job_suggestions.used).toBe(5);
      expect(body.meters.job_suggestions.activeThreshold).toBe(50);
      expect(body.meters.job_suggestions.crossedThresholds).toEqual([50]);

      // 4. Consume 2 units (70% used -> crosses 70 threshold)
      await usageService.consume(session.userId, 'job_suggestions', 2);
      res = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: session.authHeader,
      });
      body = res.json();
      expect(body.meters.job_suggestions.used).toBe(7);
      expect(body.meters.job_suggestions.activeThreshold).toBe(70);
      expect(body.meters.job_suggestions.crossedThresholds).toEqual([50, 70]);

      // 5. Consume 2 units (90% used -> crosses 90 threshold)
      await usageService.consume(session.userId, 'job_suggestions', 2);
      res = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: session.authHeader,
      });
      body = res.json();
      expect(body.meters.job_suggestions.used).toBe(9);
      expect(body.meters.job_suggestions.activeThreshold).toBe(90);
      expect(body.meters.job_suggestions.crossedThresholds).toEqual([50, 70, 90]);

      // Clean up custom plan
      await prisma.user.update({
        where: { id: session.userId },
        data: { planKey: 'unlimited' },
      });
      await prisma.plan.delete({ where: { key: planKey } });
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Meter Guard: Block With No Downstream Call at 100%
  // ---------------------------------------------------------------------------
  describe('Blocking at 100% Usage (No Downstream Call)', () => {
    let session: TestAuthSession;
    let resumeId: string;
    let jobId: string;

    beforeEach(async () => {
      session = await createTestUserAndSession(app, { username: `blocked_user_${Date.now()}` });
      await prisma.user.update({
        where: { id: session.userId },
        data: { planKey: 'demo' }, // analyses: 10
      });

      // Seed a parsed resume and job belonging to this user
      const resume = await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'test.pdf',
          storageKey: `resumes/${session.userId}/test.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          status: 'PARSED',
          parsedResume: {
            create: {
              rawText: 'Led development of distributed billing system using TypeScript and PostgreSQL.',
            },
          },
        },
      });
      resumeId = resume.id;

      const job = await prisma.job.create({
        data: {
          userId: session.userId,
          title: 'Senior Backend Engineer',
          company: 'Acme Corp',
          rawDescription: 'Looking for a senior engineer with TypeScript and distributed systems expertise.',
          status: 'ACTIVE',
        },
      });
      jobId = job.id;

      await prisma.match.create({
        data: {
          resumeId,
          jobId,
          finalScore: 85,
        },
      });

      // Max out the analyses meter to 10
      const currentPeriod = getCurrentPeriodUtc(new Date());
      await prisma.userUsage.upsert({
        where: {
          userId_meter_period: {
            userId: session.userId,
            meter: 'analyses',
            period: currentPeriod,
          },
        },
        create: {
          userId: session.userId,
          meter: 'analyses',
          period: currentPeriod,
          used: 10,
        },
        update: {
          used: 10,
        },
      });
    });

    afterEach(async () => {
      if (session?.userId) {
        await cleanupTestUser(session.userId);
      }
    });

    it('blocks POST /v1/rewriter/bullet at 100% with 429 RFC 7807 without invoking downstream ML', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/rewriter/bullet',
        headers: session.authHeader,
        payload: {
          resumeId,
          originalBullet: 'Led development of distributed billing system using TypeScript and PostgreSQL.',
          jobId,
        },
      });

      expect(res.statusCode).toBe(429);
      expect(res.headers['content-type']).toContain('application/problem+json');

      const body = res.json();
      expect(body.type).toBe('https://api.resumatch.ai/errors/usage-limit-exceeded');
      expect(body.meter).toBe('analyses');
      expect(body.used).toBe(10);
      expect(body.limit).toBe(10);
      expect(body.resetAt).not.toBeNull();

      // Crucial: Downstream ML service was NEVER called!
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('blocks POST /v1/resumes/:id/improvements at 100% with 429 RFC 7807 without invoking downstream ML', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${resumeId}/improvements`,
        headers: session.authHeader,
      });

      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.type).toBe('https://api.resumatch.ai/errors/usage-limit-exceeded');
      expect(body.meter).toBe('analyses');
      expect(body.used).toBe(10);
      expect(body.limit).toBe(10);

      // Downstream ML service was NEVER called!
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('blocks POST /v1/jobs/:id/analysis at 100% with 429 without enqueuing BullMQ job', async () => {
      const queueSpy = vi.spyOn(analysisQueue, 'add');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/analysis`,
        headers: session.authHeader,
        payload: { resumeId },
      });

      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.type).toBe('https://api.resumatch.ai/errors/usage-limit-exceeded');

      // Crucial: BullMQ task was NEVER enqueued!
      expect(queueSpy).not.toHaveBeenCalled();
      queueSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Refunds on Failures vs No Refund on llmStatus UNAVAILABLE
  // ---------------------------------------------------------------------------
  describe('Refund Policy on Downstream Results', () => {
    let session: TestAuthSession;
    let resumeId: string;

    beforeEach(async () => {
      session = await createTestUserAndSession(app, { username: `refund_user_${Date.now()}` });
      await prisma.user.update({
        where: { id: session.userId },
        data: { planKey: 'demo' },
      });

      const resume = await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'test.pdf',
          storageKey: `resumes/${session.userId}/test.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          status: 'PARSED',
          parsedResume: {
            create: {
              rawText: 'Experienced software engineer specialized in distributed systems.',
            },
          },
        },
      });
      resumeId = resume.id;
    });

    afterEach(async () => {
      if (session?.userId) {
        await cleanupTestUser(session.userId);
      }
    });

    it('refunds consumed unit when downstream returns 500 error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ detail: 'Internal ML error' }),
      } as any);

      // Verify starting usage is 0
      const initialUsage = await usageService.getUsage(session.userId);
      expect(initialUsage.meters.analyses.used).toBe(0);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/rewriter/bullet',
        headers: session.authHeader,
        payload: {
          resumeId,
          originalBullet: 'Experienced software engineer specialized in distributed systems.',
        },
      });

      expect(res.statusCode).toBe(500);

      // Meter should have been consumed then refunded back to 0
      const finalUsage = await usageService.getUsage(session.userId);
      expect(finalUsage.meters.analyses.used).toBe(0);

      fetchSpy.mockRestore();
    });

    it('refunds consumed unit when downstream encounters network exception or timeout', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Connection timed out'));

      const res = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${resumeId}/improvements`,
        headers: session.authHeader,
      });

      expect(res.statusCode).toBe(503);

      const finalUsage = await usageService.getUsage(session.userId);
      expect(finalUsage.meters.analyses.used).toBe(0);

      fetchSpy.mockRestore();
    });

    it('refunds consumed unit when downstream returns 422 HALLUCINATION_DETECTED', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({
          detail: 'HALLUCINATION_DETECTED: No rewritten options could be verified against source facts.',
        }),
      } as any);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/rewriter/bullet',
        headers: session.authHeader,
        payload: {
          resumeId,
          originalBullet: 'Experienced software engineer specialized in distributed systems.',
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().title).toBe('Hallucination Detected');

      const finalUsage = await usageService.getUsage(session.userId);
      expect(finalUsage.meters.analyses.used).toBe(0);

      fetchSpy.mockRestore();
    });

    it('does NOT refund when deterministic results are returned with llmStatus UNAVAILABLE', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'SUCCESS',
          llmStatus: 'UNAVAILABLE',
          improvements: [
            {
              category: 'ATS_HAZARD',
              issue: 'Multi-column formatting',
              suggestion: 'Convert to single column layout.',
            },
          ],
        }),
      } as any);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${resumeId}/improvements`,
        headers: session.authHeader,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().llmStatus).toBe('UNAVAILABLE');

      // The deterministic result was delivered successfully to the user, so usage REMAINS consumed (1)!
      const finalUsage = await usageService.getUsage(session.userId);
      expect(finalUsage.meters.analyses.used).toBe(1);

      fetchSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Storage Gauge Lifecycle (Upload, Delete, Account Deletion)
  // ---------------------------------------------------------------------------
  describe('Storage Gauge Lifecycle', () => {
    let session: TestAuthSession;

    beforeEach(async () => {
      session = await createTestUserAndSession(app, { username: `storage_user_${Date.now()}` });
      // demo plan has resume_storage_bytes limit: 5242880 (5MB)
      await prisma.user.update({
        where: { id: session.userId },
        data: { planKey: 'demo' },
      });
    });

    afterEach(async () => {
      if (session?.userId) {
        await cleanupTestUser(session.userId);
      }
    });

    it('rejects upload-url request with 429 when declared size would exceed storage limit', async () => {
      // Demo limit is 5,242,880 bytes. Pre-consume 4,000,000 bytes into storage gauge
      await usageService.consume(session.userId, 'resume_storage_bytes', 4_000_000);

      // Attempt to request an upload URL for 2MB file (2MB is under per-file MAX_UPLOAD_BYTES, but exceeds remaining 1.24MB quota)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resumes/upload-url',
        headers: session.authHeader,
        payload: {
          filename: 'large_resume.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 2_000_000,
        },
      });

      expect(res.statusCode).toBe(429);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const body = res.json();
      expect(body.type).toBe('https://api.resumatch.ai/errors/usage-limit-exceeded');
      expect(body.meter).toBe('resume_storage_bytes');
      expect(body.used).toBe(4_000_000);
      expect(body.limit).toBe(5_242_880);
    });

    it('increments storage gauge on upload completion and decrements on deletion', async () => {
      const fileSize = 200_000; // 200 KB

      // Verify starting storage is 0
      const initialUsage = await usageService.getUsage(session.userId);
      expect(initialUsage.meters.resume_storage_bytes.used).toBe(0);

      // Create a resume in UPLOAD_PENDING status
      const resume = await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'cv.pdf',
          storageKey: `resumes/${session.userId}/cv.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: fileSize,
          status: 'UPLOAD_PENDING',
        },
      });

      // Mock S3 head and byte range for complete upload
      const spyHead = vi.spyOn(storageModule, 'headStorageObject').mockResolvedValue({
        contentLength: fileSize,
        lastModified: new Date(),
        contentType: 'application/pdf',
      } as any);

      const spyRange = vi.spyOn(storageModule, 'getStorageObjectByteRange').mockResolvedValue(
        Buffer.from('%PDF-1.4 Mock PDF content')
      );

      const completeRes = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${resume.id}/complete`,
        headers: session.authHeader,
      });

      expect(completeRes.statusCode).toBe(202);

      // Storage gauge increased by fileSize
      const afterUploadUsage = await usageService.getUsage(session.userId);
      expect(afterUploadUsage.meters.resume_storage_bytes.used).toBe(fileSize);

      // Now delete the resume
      const spyDelete = vi.spyOn(storageModule, 'deleteStorageObject').mockResolvedValue();

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/v1/resumes/${resume.id}`,
        headers: session.authHeader,
      });

      expect(deleteRes.statusCode).toBe(200);

      // Storage gauge decreased back to 0
      const afterDeleteUsage = await usageService.getUsage(session.userId);
      expect(afterDeleteUsage.meters.resume_storage_bytes.used).toBe(0);

      spyHead.mockRestore();
      spyRange.mockRestore();
      spyDelete.mockRestore();
    });

    it('retains storage gauge consumption when a resume transitions to FAILED, and deducts bytes on deletion', async () => {
      const fileSize = 150_000;

      // 1. Create a resume in UPLOAD_PENDING status
      const resume = await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'failed_candidate.pdf',
          storageKey: `resumes/${session.userId}/failed_candidate.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: fileSize,
          status: 'UPLOAD_PENDING',
        },
      });

      const spyHead = vi.spyOn(storageModule, 'headStorageObject').mockResolvedValue({
        contentLength: fileSize,
        lastModified: new Date(),
        contentType: 'application/pdf',
      } as any);

      const spyRange = vi.spyOn(storageModule, 'getStorageObjectByteRange').mockResolvedValue(
        Buffer.from('%PDF-1.4 Mock PDF content')
      );

      const completeRes = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${resume.id}/complete`,
        headers: session.authHeader,
      });
      expect(completeRes.statusCode).toBe(202);

      // Verify storage gauge is incremented
      let usage = await usageService.getUsage(session.userId);
      expect(usage.meters.resume_storage_bytes.used).toBe(fileSize);

      // 2. Background worker fails to parse document and marks resume FAILED
      await prisma.resume.update({
        where: { id: resume.id },
        data: {
          status: 'FAILED',
          errorCode: 'CORRUPT_FILE',
          errorMessage: 'Unable to parse document',
        },
      });

      // 3. Storage bytes remain counted because the physical S3 object is retained in storage
      usage = await usageService.getUsage(session.userId);
      expect(usage.meters.resume_storage_bytes.used).toBe(fileSize);

      // 4. When the user explicitly deletes the FAILED resume, S3 object is removed and bytes are deducted
      const spyDelete = vi.spyOn(storageModule, 'deleteStorageObject').mockResolvedValue();

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/v1/resumes/${resume.id}`,
        headers: session.authHeader,
      });
      expect(deleteRes.statusCode).toBe(200);

      // Verify storage gauge drops back to 0
      usage = await usageService.getUsage(session.userId);
      expect(usage.meters.resume_storage_bytes.used).toBe(0);

      spyHead.mockRestore();
      spyRange.mockRestore();
      spyDelete.mockRestore();
    });

    it('does not subtract storage when deleting UPLOAD_PENDING resumes; repeating 5 times never drops gauge below actual stored total', async () => {
      const activeSize = 500_000;

      // 1. Create and complete an active resume of 500 KB
      const activeResume = await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'active.pdf',
          storageKey: `resumes/${session.userId}/active.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: activeSize,
          status: 'UPLOAD_PENDING',
        },
      });

      const spyHead = vi.spyOn(storageModule, 'headStorageObject').mockResolvedValue({
        contentLength: activeSize,
        lastModified: new Date(),
        contentType: 'application/pdf',
      } as any);

      const spyRange = vi.spyOn(storageModule, 'getStorageObjectByteRange').mockResolvedValue(
        Buffer.from('%PDF-1.4 Mock PDF content')
      );

      const completeRes = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${activeResume.id}/complete`,
        headers: session.authHeader,
      });
      expect(completeRes.statusCode).toBe(202);

      let usage = await usageService.getUsage(session.userId);
      expect(usage.meters.resume_storage_bytes.used).toBe(activeSize);

      // 2. Repeat 5 times: request upload-url for 2 MB without completing, then delete
      const spyDelete = vi.spyOn(storageModule, 'deleteStorageObject').mockResolvedValue();

      for (let i = 0; i < 5; i++) {
        const uploadUrlRes = await app.inject({
          method: 'POST',
          url: '/v1/resumes/upload-url',
          headers: session.authHeader,
          payload: {
            filename: `abandoned_${i}.pdf`,
            mimeType: 'application/pdf',
            sizeBytes: 2_000_000,
          },
        });
        expect(uploadUrlRes.statusCode).toBe(200);
        const { resumeId } = uploadUrlRes.json();

        // Gauge must remain activeSize (upload not completed)
        usage = await usageService.getUsage(session.userId);
        expect(usage.meters.resume_storage_bytes.used).toBe(activeSize);

        // Delete the pending resume
        const delRes = await app.inject({
          method: 'DELETE',
          url: `/v1/resumes/${resumeId}`,
          headers: session.authHeader,
        });
        expect(delRes.statusCode).toBe(200);

        // Gauge must STILL be exactly activeSize (never drops below real stored total)
        usage = await usageService.getUsage(session.userId);
        expect(usage.meters.resume_storage_bytes.used).toBe(activeSize);
      }

      spyHead.mockRestore();
      spyRange.mockRestore();
      spyDelete.mockRestore();
    });

    it('deleting the same resume twice does not double-subtract (second call returns 404)', async () => {
      const size1 = 200_000;
      const size2 = 300_000;

      // Consume initial storage for two active resumes
      await usageService.consume(session.userId, 'resume_storage_bytes', size1 + size2);

      const res1 = await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'res1.pdf',
          storageKey: `resumes/${session.userId}/res1.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: size1,
          status: 'UPLOADED',
        },
      });

      const spyDelete = vi.spyOn(storageModule, 'deleteStorageObject').mockResolvedValue();

      // First delete -> 200 OK, subtracts size1
      const del1 = await app.inject({
        method: 'DELETE',
        url: `/v1/resumes/${res1.id}`,
        headers: session.authHeader,
      });
      expect(del1.statusCode).toBe(200);

      let usage = await usageService.getUsage(session.userId);
      expect(usage.meters.resume_storage_bytes.used).toBe(size2);

      // Second delete -> 404 Not Found, no double subtraction
      const del2 = await app.inject({
        method: 'DELETE',
        url: `/v1/resumes/${res1.id}`,
        headers: session.authHeader,
      });
      expect(del2.statusCode).toBe(404);

      usage = await usageService.getUsage(session.userId);
      expect(usage.meters.resume_storage_bytes.used).toBe(size2);

      spyDelete.mockRestore();
    });

    it('cleanup worker removes stale UPLOAD_PENDING resume without altering storage gauge', async () => {
      // User has 100KB stored
      await usageService.consume(session.userId, 'resume_storage_bytes', 100_000);

      // Create a stale UPLOAD_PENDING resume created 48h ago
      const staleResume = await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'stale.pdf',
          storageKey: `resumes/${session.userId}/stale.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 500_000,
          status: 'UPLOAD_PENDING',
          createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        },
      });

      const spyHead = vi.spyOn(storageModule, 'headStorageObject').mockResolvedValue(null);

      const cleanupResult = await cleanupStaleUploadPending({
        cutoffDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      expect(cleanupResult.cleaned).toBeGreaterThanOrEqual(1);

      // Verify resume is deleted from database
      const found = await prisma.resume.findUnique({ where: { id: staleResume.id } });
      expect(found).toBeNull();

      // Verify storage gauge is unchanged (still 100KB)
      const usage = await usageService.getUsage(session.userId);
      expect(usage.meters.resume_storage_bytes.used).toBe(100_000);

      spyHead.mockRestore();
    });

    it('satisfies storage reconciliation check: gauge == SUM(sizeBytes) of status != UPLOAD_PENDING', async () => {
      // 1 completed resume (PARSED, 200,000 bytes)
      // 1 failed resume (FAILED, 150,000 bytes)
      // 1 pending resume (UPLOAD_PENDING, 2,000,000 bytes)
      await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'parsed.pdf',
          storageKey: `resumes/${session.userId}/parsed.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 200_000,
          status: 'PARSED',
        },
      });

      await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'failed.pdf',
          storageKey: `resumes/${session.userId}/failed.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 150_000,
          status: 'FAILED',
        },
      });

      await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'pending.pdf',
          storageKey: `resumes/${session.userId}/pending.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 2_000_000,
          status: 'UPLOAD_PENDING',
        },
      });

      // Gauge correctly tracks the two completed resumes (200,000 + 150,000 = 350,000)
      await usageService.consume(session.userId, 'resume_storage_bytes', 350_000);

      const usage = await usageService.getUsage(session.userId);
      const gaugeBytes = usage.meters.resume_storage_bytes.used;

      // Execute reconciliation query for this user
      const expectedRes = await prisma.$queryRaw<Array<{ sum: bigint | null }>>`
        SELECT COALESCE(SUM("sizeBytes"), 0) as sum
        FROM "resumes"
        WHERE "userId" = ${session.userId} AND "status" != 'UPLOAD_PENDING';
      `;
      const expectedBytes = Number(expectedRes[0]?.sum ?? 0);

      expect(gaugeBytes).toBe(350_000);
      expect(expectedBytes).toBe(350_000);
      expect(gaugeBytes).toBe(expectedBytes);
    });

    it('cascades and removes user_usage records upon account deletion', async () => {
      // Consume some usage
      await usageService.consume(session.userId, 'analyses', 3);
      await usageService.consume(session.userId, 'resume_storage_bytes', 15000);

      const beforeDelete = await prisma.userUsage.count({ where: { userId: session.userId } });
      expect(beforeDelete).toBeGreaterThan(0);

      // Delete account with password confirmation
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: session.authHeader,
        payload: {
          password: 'SecurePassword123!',
        },
      });

      expect(deleteRes.statusCode).toBe(200);

      // All usage rows for user are cascade deleted by Postgres FK
      const afterDelete = await prisma.userUsage.count({ where: { userId: session.userId } });
      expect(afterDelete).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Tenant Isolation & Route Inventory
  // ---------------------------------------------------------------------------
  describe('Tenant Isolation & Route Inventory', () => {
    let userA: TestAuthSession;
    let userB: TestAuthSession;

    beforeAll(async () => {
      userA = await createTestUserAndSession(app, { username: `user_a_${Date.now()}` });
      userB = await createTestUserAndSession(app, { username: `user_b_${Date.now()}` });

      await prisma.user.update({
        where: { id: userA.userId },
        data: { planKey: 'demo' },
      });

      await prisma.user.update({
        where: { id: userB.userId },
        data: { planKey: 'demo' },
      });

      // User A consumes 4 analyses
      await usageService.consume(userA.userId, 'analyses', 4);

      // User B consumes 9 analyses
      await usageService.consume(userB.userId, 'analyses', 9);
    });

    afterAll(async () => {
      if (userA?.userId) await cleanupTestUser(userA.userId);
      if (userB?.userId) await cleanupTestUser(userB.userId);
    });

    it('/v1/usage returns strictly the caller usage data with Cache-Control: no-store', async () => {
      const resA = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: userA.authHeader,
      });

      expect(resA.statusCode).toBe(200);
      expect(resA.headers['cache-control']).toBe('no-store');
      const bodyA = resA.json();
      expect(bodyA.plan).toBe('demo');
      expect(bodyA.meters.analyses.used).toBe(4);
      expect(bodyA.meters.analyses.percent).toBe(40);
      expect(bodyA.meters.analyses.activeThreshold).toBeNull();

      const resB = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: userB.authHeader,
      });

      expect(resB.statusCode).toBe(200);
      const bodyB = resB.json();
      expect(bodyB.meters.analyses.used).toBe(9);
      expect(bodyB.meters.analyses.percent).toBe(90);
      expect(bodyB.meters.analyses.activeThreshold).toBe(90);
      expect(bodyB.meters.analyses.crossedThresholds).toEqual([50, 70, 90]);
    });

    it('verifies route inventory: every LLM-backed route is metered and requires auth', async () => {
      const meteredRoutes = [
        { method: 'POST', url: '/v1/rewriter/bullet' },
        { method: 'POST', url: '/v1/resumes/11111111-1111-1111-1111-111111111111/improvements' },
        { method: 'POST', url: '/v1/jobs/11111111-1111-1111-1111-111111111111/analysis' },
      ];

      for (const route of meteredRoutes) {
        const unauthRes = await app.inject({
          method: route.method as any,
          url: route.url,
        });

        // 1. Must return 401 unauthenticated
        expect(unauthRes.statusCode, `${route.method} ${route.url} must be protected`).toBe(401);
      }
    });

    it('ignores client-spoofed headers attempting plan or usage bypass', async () => {
      // User B attempts to send spoofed plan headers
      const res = await app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: {
          ...userB.authHeader,
          'X-User-Plan': 'unlimited',
          'X-Plan': 'unlimited',
          'X-Usage-Bypass': 'true',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Server strictly enforces database plan 'demo', ignoring client's spoofed 'unlimited' headers
      expect(body.plan).toBe('demo');
    });
  });
});
