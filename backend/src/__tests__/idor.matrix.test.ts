/**
 * Comprehensive IDOR & Route Authorization Test Matrix (Phase 9 - C1)
 *
 * Requirements:
 * 1. Collects the complete route inventory from the running Fastify instance.
 * 2. Compares every registered route against an explicit table-driven matrix.
 *    FAILS immediately if any route is registered without a matrix entry.
 * 3. Tests every authenticated route against:
 *    - Unauthenticated request (no token/cookie) -> 401 Unauthorized
 *    - Invalid / expired token -> 401 Unauthorized
 * 4. Tests every state-changing route (POST, PUT, DELETE) against:
 *    - Cookie auth without CSRF token -> 403 Forbidden
 *    - Cookie auth with untrusted origin -> 403 Forbidden
 * 5. Tests tenant isolation across resource endpoints:
 *    - User B accessing User A's resource -> 404 Not Found (404 anti-enumeration convention)
 *    - User A accessing User A's resource -> allowed (not 401/403/404)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildServer } from '../server.js';

// ---------------------------------------------------------------------------
// Module Mocks
// ---------------------------------------------------------------------------
vi.mock('../db/prisma.js', () => ({
  prisma: {
    resume: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    job: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    match: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    session: {
      findUnique: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    credential: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    recoveryCode: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (callback: any) => {
      const txMock = {
        resume: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
        auditLog: { create: vi.fn() },
        session: { deleteMany: vi.fn() },
        recoveryCode: { deleteMany: vi.fn(), createMany: vi.fn() },
      };
      return callback(txMock);
    }),
  },
  checkDatabaseHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

vi.mock('../storage/s3.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../storage/s3.js')>();
  return {
    ...original,
    createPresignedUploadUrl: vi.fn(),
    createPresignedDownloadUrl: vi.fn(),
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
    resumeParsingQueue: { add: vi.fn().mockResolvedValue({ id: 'mock-parse-job' }), getJob: vi.fn() },
    embeddingQueue: { add: vi.fn().mockResolvedValue({ id: 'mock-embed-job' }) },
    matchScoringQueue: { add: vi.fn().mockResolvedValue({ id: 'mock-match-job' }) },
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

vi.mock('../utils/coordinationLock.js', () => ({
  withResumeCoordinationLock: vi.fn(async (_resumeId: string, fn: any) => {
    const { prisma } = await import('../db/prisma.js');
    return fn(prisma);
  }),
}));

import { prisma } from '../db/prisma.js';

interface RouteMatrixEntry {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  url: string;
  isPublic: boolean;
  tenantBound?: boolean; // resource owned by specific user; User B on User A should 404
}

// ---------------------------------------------------------------------------
// Authoritative Route Matrix Definition
// ---------------------------------------------------------------------------
export const ROUTE_SECURITY_MATRIX: RouteMatrixEntry[] = [
  // Health
  { method: 'GET', url: '/health', isPublic: true },
  { method: 'HEAD', url: '/health', isPublic: true },

  // Public Authentication Endpoints
  { method: 'POST', url: '/v1/auth/register', isPublic: true },
  { method: 'POST', url: '/v1/auth/login', isPublic: true },
  { method: 'POST', url: '/v1/auth/refresh', isPublic: true },
  { method: 'POST', url: '/v1/auth/recover', isPublic: true },

  // Authenticated Auth Management
  { method: 'POST', url: '/v1/auth/logout', isPublic: false },
  { method: 'POST', url: '/v1/auth/logout-all', isPublic: false },
  { method: 'POST', url: '/v1/auth/revoke-all', isPublic: false },
  { method: 'GET', url: '/v1/auth/me', isPublic: false },
  { method: 'GET', url: '/v1/auth/session', isPublic: false },
  { method: 'GET', url: '/v1/auth/sessions', isPublic: false },
  { method: 'POST', url: '/v1/auth/recovery-codes/regenerate', isPublic: false },
  { method: 'DELETE', url: '/v1/account', isPublic: false },

  // Resumes
  { method: 'POST', url: '/v1/resumes/upload-url', isPublic: false },
  { method: 'POST', url: '/v1/resumes/:id/complete', isPublic: false, tenantBound: true },
  { method: 'GET', url: '/v1/resumes', isPublic: false },
  { method: 'GET', url: '/v1/resumes/:id', isPublic: false, tenantBound: true },
  { method: 'GET', url: '/v1/resumes/:id/download-url', isPublic: false, tenantBound: true },
  { method: 'GET', url: '/v1/resumes/:id/matches', isPublic: false, tenantBound: true },
  { method: 'DELETE', url: '/v1/resumes/:id', isPublic: false, tenantBound: true },

  // Analyses
  { method: 'GET', url: '/v1/analyses', isPublic: false },
  { method: 'POST', url: '/v1/analyses', isPublic: false },
  { method: 'GET', url: '/v1/analyses/:id', isPublic: false, tenantBound: true },

  // Jobs
  { method: 'POST', url: '/v1/jobs', isPublic: false },
  { method: 'GET', url: '/v1/jobs', isPublic: false },
  { method: 'GET', url: '/v1/jobs/:id', isPublic: false, tenantBound: true },
  { method: 'DELETE', url: '/v1/jobs/:id', isPublic: false, tenantBound: true },
  { method: 'POST', url: '/v1/jobs/:id/match', isPublic: false, tenantBound: true },
  { method: 'POST', url: '/v1/jobs/:id/analysis', isPublic: false, tenantBound: true },
  { method: 'GET', url: '/v1/jobs/:id/matches', isPublic: false, tenantBound: true },
  { method: 'GET', url: '/v1/jobs/:id/matches/:resumeId', isPublic: false, tenantBound: true },
  { method: 'GET', url: '/v1/jobs/:id/analysis/:resumeId', isPublic: false, tenantBound: true },

  // Rewriter & Improvements
  { method: 'POST', url: '/v1/rewriter/bullet', isPublic: false },
  { method: 'POST', url: '/v1/resumes/:resumeId/improvements', isPublic: false, tenantBound: true },

  // Usage & Metering
  { method: 'GET', url: '/v1/usage', isPublic: false },

  // Suggestions
  { method: 'POST', url: '/v1/resumes/:id/suggestions', isPublic: false, tenantBound: true },
];

describe('Comprehensive Route Security & IDOR Verification Matrix', () => {
  let app: FastifyInstance;
  const discoveredRoutes: { method: string; url: string }[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    discoveredRoutes.length = 0;

    app = buildServer({
      onRoute: (routeOptions: RouteOptions) => {
        const methods = Array.isArray(routeOptions.method)
          ? routeOptions.method
          : [routeOptions.method];
        for (const m of methods) {
          discoveredRoutes.push({ method: m.toUpperCase(), url: routeOptions.url });
        }
      },
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // Helper tokens
  const makeToken = (userId: string, email = `${userId}@example.com`) =>
    app.jwt.sign({ sub: userId, email });

  // -------------------------------------------------------------------------
  // 1. Dynamic Route Table Completeness Assertion
  // -------------------------------------------------------------------------
  it('verifies that EVERY registered Fastify route exists in the security matrix', () => {
    const ignoredPaths = new Set([
      '/resumes',
      '/resumes/*',
      '/resumes/:id',
      '/jobs',
      '/jobs/*',
      '/analyses',
      '/analyses/*',
      '/analyses/:id',
    ]); // Phase 1 501 legacy stubs

    for (const discovered of discoveredRoutes) {
      if (discovered.method === 'HEAD' || discovered.method === 'OPTIONS') {
        continue;
      }
      if (ignoredPaths.has(discovered.url)) {
        continue;
      }

      const match = ROUTE_SECURITY_MATRIX.find(
        (entry) =>
          entry.method === discovered.method &&
          (entry.url === discovered.url ||
            entry.url.replace(/:[a-zA-Z0-9_]+/g, '.*') === discovered.url.replace(/:[a-zA-Z0-9_]+/g, '.*'))
      );

      expect(
        match,
        `SECURITY VIOLATION: Route [${discovered.method} ${discovered.url}] is registered on Fastify ` +
          `but has NO corresponding entry in ROUTE_SECURITY_MATRIX! Add an explicit entry to ensure auth/IDOR coverage.`
      ).toBeDefined();
    }
  });

  // -------------------------------------------------------------------------
  // 2. Authentication Enforcement on All Protected Routes
  // -------------------------------------------------------------------------
  describe('Authentication Enforcement (401 for Missing or Invalid Token)', () => {
    const protectedRoutes = ROUTE_SECURITY_MATRIX.filter((r) => !r.isPublic && r.method !== 'HEAD');

    it.each(protectedRoutes)(
      'rejects unauthenticated request on $method $url with 401',
      async ({ method, url }) => {
        const testUrl = url
          .replace(':id', '00000000-0000-0000-0000-000000000001')
          .replace(':resumeId', '00000000-0000-0000-0000-000000000002');

        const res = await app.inject({
          method,
          url: testUrl,
        });

        expect(res.statusCode).toBe(401);
      }
    );

    it.each(protectedRoutes)(
      'rejects invalid token on $method $url with 401',
      async ({ method, url }) => {
        const testUrl = url
          .replace(':id', '00000000-0000-0000-0000-000000000001')
          .replace(':resumeId', '00000000-0000-0000-0000-000000000002');

        const res = await app.inject({
          method,
          url: testUrl,
          headers: { Authorization: 'Bearer totally-invalid-token' },
        });

        expect(res.statusCode).toBe(401);
      }
    );
  });

  // -------------------------------------------------------------------------
  // 3. CSRF Protection on Protected Mutation Routes (Cookie Auth)
  // -------------------------------------------------------------------------
  describe('Double-Submit CSRF Enforcement on Protected Mutations', () => {
    const mutationRoutes = ROUTE_SECURITY_MATRIX.filter(
      (r) => !r.isPublic && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(r.method)
    );

    it.each(mutationRoutes)(
      'rejects cookie-authenticated mutation on $method $url when CSRF header is missing (403)',
      async ({ method, url }) => {
        const testUrl = url
          .replace(':id', '00000000-0000-0000-0000-000000000001')
          .replace(':resumeId', '00000000-0000-0000-0000-000000000002');

        const validAccessToken = makeToken('user-1');

        const res = await app.inject({
          method,
          url: testUrl,
          cookies: {
            access_token: validAccessToken,
            csrf_token: 'valid-csrf-token-abc123',
          },
          headers: {
            origin: 'http://localhost:3000',
            // Missing x-csrf-token header
          },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json().message).toContain('CSRF protection failed');
      }
    );

    it.each(mutationRoutes)(
      'rejects cookie-authenticated mutation on $method $url when origin is untrusted (403)',
      async ({ method, url }) => {
        const testUrl = url
          .replace(':id', '00000000-0000-0000-0000-000000000001')
          .replace(':resumeId', '00000000-0000-0000-0000-000000000002');

        const validAccessToken = makeToken('user-1');

        const res = await app.inject({
          method,
          url: testUrl,
          cookies: {
            access_token: validAccessToken,
            csrf_token: 'valid-csrf-token-abc123',
          },
          headers: {
            origin: 'http://malicious-attacker-site.com',
            'x-csrf-token': 'valid-csrf-token-abc123',
          },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json().message).toContain('CSRF protection failed');
      }
    );
  });

  // -------------------------------------------------------------------------
  // 4. Cross-Tenant IDOR Isolation (404 Anti-Enumeration Convention)
  // -------------------------------------------------------------------------
  describe('Cross-Tenant Data Isolation (User B cannot access User A resources)', () => {
    const userAToken = () => `Bearer ${makeToken('user-A')}`;
    const userBToken = () => `Bearer ${makeToken('user-B')}`;

    const resourceA = {
      id: 'res-user-a-1234',
      userId: 'user-A',
      title: 'Senior Engineer',
      status: 'PARSED',
      storageKey: 'resumes/user-A/res-user-a-1234.pdf',
    };

    it('User B cannot retrieve User A resume details (returns 404)', async () => {
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(resourceA as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/resumes/${resourceA.id}`,
        headers: { Authorization: userBToken() },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('not found');
    });

    it('User B cannot delete User A resume (returns 404)', async () => {
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(resourceA as any);

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/resumes/${resourceA.id}`,
        headers: { Authorization: userBToken() },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('not found');
    });

    it('User B cannot retrieve download URL for User A resume (returns 404)', async () => {
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(resourceA as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/resumes/${resourceA.id}/download-url`,
        headers: { Authorization: userBToken() },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('not found');
    });

    it('User B cannot view User A job (returns 404)', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValueOnce(resourceA as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${resourceA.id}`,
        headers: { Authorization: userBToken() },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('not found');
    });

    it('User B cannot trigger match on User A job (returns 404)', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValueOnce(resourceA as any);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${resourceA.id}/match`,
        headers: { Authorization: userBToken() },
        payload: { resumeId: '00000000-0000-0000-0000-000000000001' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('not found');
    });

    it('User A CAN retrieve User A own resume details (200 OK)', async () => {
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(resourceA as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/resumes/${resourceA.id}`,
        headers: { Authorization: userAToken() },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(resourceA.id);
    });
  });
});
