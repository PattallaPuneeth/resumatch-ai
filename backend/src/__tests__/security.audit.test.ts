/**
 * Phase 1-3 Comprehensive Security Audit & Verification Regression Suite
 *
 * Covers:
 * 1. JWT validation, expiry, tampering, missing claims, and wrong secret rejection
 * 2. Cross-tenant isolation across all endpoints (resumes, jobs, matches, downloads, deletions)
 * 3. Upload MIME, extension, size spoofing, and server-side magic byte enforcement
 * 4. Rate-limit enforcement on /v1/resumes/upload-url
 * 5. CORS policy enforcement for allowed vs malicious origins
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { buildServer } from '../server.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Module mocks
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
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (callback: any) => {
      const txMock = {
        resume: {
          findUnique: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        auditLog: {
          create: vi.fn(),
        },
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
    resumeParsingQueue: {
      add: vi.fn().mockResolvedValue({ id: 'mock-parse-job-id' }),
      getJob: vi.fn(),
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
  createRedisClient: vi.fn(),
}));

vi.mock('../storage/minio.js', () => ({
  checkMinioHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

// Mock coordination lock to run inner callback directly
vi.mock('../utils/coordinationLock.js', () => ({
  withResumeCoordinationLock: vi.fn(async (_resumeId: string, fn: any) => {
    const { prisma } = await import('../db/prisma.js');
    return fn(prisma);
  }),
}));

import {
  createPresignedUploadUrl,
  headStorageObject,
  getStorageObjectByteRange,
  deleteStorageObject,
} from '../storage/s3.js';
import { prisma } from '../db/prisma.js';

const mockCreatePresignedUploadUrl = vi.mocked(createPresignedUploadUrl);
const mockHeadStorageObject = vi.mocked(headStorageObject);
const mockGetStorageObjectByteRange = vi.mocked(getStorageObjectByteRange);
const mockDeleteStorageObject = vi.mocked(deleteStorageObject);

describe('Security Audit & Verification Suite (Phases 1-3)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // 1. JWT Authentication, Expiry, Tampering & Missing Claims
  // -------------------------------------------------------------------------
  describe('JWT Validation & Tampering Resistance', () => {
    it('rejects requests with no Authorization header (401)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('rejects malformed bearer tokens (401)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes',
        headers: { Authorization: 'Bearer not-a-valid-jwt-token' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('rejects tokens signed with an unauthorized secret (401)', async () => {
      const attackerApp = Fastify();
      await attackerApp.register(fastifyJwt, { secret: 'wrong-secret-key-that-does-not-match-env-secret' });
      const forgedToken = attackerApp.jwt.sign({ sub: 'attacker-id', email: 'attacker@evil.com' });
      await attackerApp.close();

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes',
        headers: { Authorization: `Bearer ${forgedToken}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('rejects expired JWT tokens (401)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiredToken = app.jwt.sign(
        { sub: 'user-1', email: 'test@example.com', iat: now - 3600, exp: now - 60 }
      );
      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes',
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('rejects tokens missing the subject identifier claim (401)', async () => {
      const tokenWithoutSub = app.jwt.sign({ email: 'no-sub@example.com' } as any);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes',
        headers: { Authorization: `Bearer ${tokenWithoutSub}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('missing subject identifier');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Cross-Tenant Isolation Across All Endpoints
  // -------------------------------------------------------------------------
  describe('Cross-Tenant Data Isolation', () => {
    const userBToken = () => `Bearer ${app.jwt.sign({ sub: 'user-B', email: 'b@example.com' })}`;

    const resumeOwnedByA = {
      id: 'resume-of-user-a',
      userId: 'user-A',
      originalFilename: 'userA_cv.pdf',
      storageKey: 'resumes/user-A/resume-of-user-a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      status: 'PARSED',
      sha256: 'abc123hash',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const jobOwnedByA = {
      id: 'job-of-user-a',
      userId: 'user-A',
      title: 'Backend Engineer',
      company: 'Tech A',
      rawDescription: 'Must know Python, Postgres, and Docker.',
      status: 'ACTIVE',
      _count: { chunks: 2 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('User B cannot retrieve User A resume details (403 Forbidden)', async () => {
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(resumeOwnedByA as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/resumes/${resumeOwnedByA.id}`,
        headers: { Authorization: userBToken() },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('permission');
    });

    it('User B cannot trigger upload complete for User A resume (403 Forbidden)', async () => {
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(resumeOwnedByA as any);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${resumeOwnedByA.id}/complete`,
        headers: { Authorization: userBToken() },
        payload: {},
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('permission');
    });

    it('User B cannot retrieve download URL for User A resume (403 Forbidden)', async () => {
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(resumeOwnedByA as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/resumes/${resumeOwnedByA.id}/download-url`,
        headers: { Authorization: userBToken() },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('permission');
    });

    it('User B cannot delete User A resume (403 Forbidden)', async () => {
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(resumeOwnedByA as any);

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/resumes/${resumeOwnedByA.id}`,
        headers: { Authorization: userBToken() },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('permission');
    });

    it('User B listing resumes never includes User A records', async () => {
      vi.mocked(prisma.resume.findMany).mockResolvedValueOnce([]);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes',
        headers: { Authorization: userBToken() },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().resumes).toEqual([]);
      expect(prisma.resume.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-B' }),
        })
      );
    });

    it('User B accessing User A job returns 404 (tenant-isolated convention)', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValueOnce(jobOwnedByA as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${jobOwnedByA.id}`,
        headers: { Authorization: userBToken() },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('Job not found');
    });

    it('User B triggering match on User A job returns 404', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValueOnce(jobOwnedByA as any);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobOwnedByA.id}/match`,
        headers: { Authorization: userBToken() },
        payload: { resumeId: '00000000-0000-0000-0000-000000000001' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('Job not found');
    });

    it('User B accessing User A job match result returns 404', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValueOnce(jobOwnedByA as any);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${jobOwnedByA.id}/matches/${resumeOwnedByA.id}`,
        headers: { Authorization: userBToken() },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('Job not found');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Upload Validation & Server-Side Content Verification
  // -------------------------------------------------------------------------
  describe('Upload Type, Size & Content Verification', () => {
    const validToken = () => `Bearer ${app.jwt.sign({ sub: 'user-1', email: 'test@example.com' })}`;

    it('rejects unsupported executable extensions (.exe) with 400 Bad Request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resumes/upload-url',
        headers: { Authorization: validToken() },
        payload: {
          filename: 'trojan.exe',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('Input validation failed');
    });

    it('rejects disallowed MIME types with 422 Unprocessable Entity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resumes/upload-url',
        headers: { Authorization: validToken() },
        payload: {
          filename: 'script.pdf',
          mimeType: 'application/x-sh',
          sizeBytes: 1024,
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().message).toContain('Unsupported file type');
    });

    it('rejects extension vs MIME mismatch (docx named with .pdf) with 422', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resumes/upload-url',
        headers: { Authorization: validToken() },
        payload: {
          filename: 'cv.pdf',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 1024,
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().message).toContain('does not match MIME type');
    });

    it('accepts boundary declared file size of exactly 5 MiB (5,242,880 bytes) on upload-url with 200', async () => {
      vi.mocked(prisma.resume.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.resume.create).mockResolvedValueOnce({
        id: 'mock-resume-id',
        userId: 'user-1',
        storageKey: 'resumes/user-1/mock-resume-id.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 5242880,
        status: 'UPLOAD_PENDING',
      } as any);
      mockCreatePresignedUploadUrl.mockResolvedValueOnce({
        uploadUrl: 'http://localhost:9000/resumes/upload',
        fields: {},
      } as any);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/resumes/upload-url',
        headers: { Authorization: validToken() },
        payload: {
          filename: 'cv.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 5 * 1024 * 1024, // Exactly 5,242,880 bytes
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().resumeId).toBeDefined();
      expect(res.json().uploadUrl).toBe('http://localhost:9000/resumes/upload');
    });

    it('rejects boundary declared file size of 5 MiB + 1 byte (5,242,881 bytes) on upload-url with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resumes/upload-url',
        headers: { Authorization: validToken() },
        payload: {
          filename: 'cv.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 5 * 1024 * 1024 + 1, // 5,242,881 bytes
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('Input validation failed');
      const details = res.json().details;
      expect(JSON.stringify(details)).toContain('File exceeds maximum size of 5242880 bytes');
    });

    it('rejects clearly oversized declared file size (10 MiB / 10,485,760 bytes) on upload-url with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resumes/upload-url',
        headers: { Authorization: validToken() },
        payload: {
          filename: 'huge_cv.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10 * 1024 * 1024, // 10 MiB
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('Input validation failed');
    });

    it('allows actual S3 object of exactly 5 MiB (5,242,880 bytes) through size check on complete', async () => {
      const pendingResume = {
        id: 'resume-exact-complete',
        userId: 'user-1',
        storageKey: 'resumes/user-1/resume-exact-complete.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 5242880,
        status: 'UPLOAD_PENDING',
      };
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(pendingResume as any);
      mockHeadStorageObject.mockResolvedValueOnce({ contentLength: 5 * 1024 * 1024 } as any);
      // Valid PDF magic bytes %PDF-
      mockGetStorageObjectByteRange.mockResolvedValueOnce(Buffer.from('%PDF-1.7'));
      // Full bytes for sha256
      mockGetStorageObjectByteRange.mockResolvedValueOnce(Buffer.from('%PDF-1.7 dummy content'));
      vi.mocked(prisma.resume.update).mockResolvedValueOnce({ ...pendingResume, status: 'UPLOADED' } as any);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${pendingResume.id}/complete`,
        headers: { Authorization: validToken() },
        payload: {},
      });

      expect(res.statusCode).toBe(202);
      expect(mockDeleteStorageObject).not.toHaveBeenCalled();
    });

    it('detects and rejects actual S3 object of 5 MiB + 1 byte (5,242,881 bytes) on complete with 422', async () => {
      const pendingResume = {
        id: 'resume-boundary-plus-one',
        userId: 'user-1',
        storageKey: 'resumes/user-1/resume-boundary-plus-one.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        status: 'UPLOAD_PENDING',
      };
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(pendingResume as any);
      vi.mocked(prisma.resume.update).mockResolvedValueOnce({ ...pendingResume, status: 'FAILED' } as any);
      mockHeadStorageObject.mockResolvedValueOnce({ contentLength: 5 * 1024 * 1024 + 1 } as any); // 5,242,881 bytes
      mockDeleteStorageObject.mockResolvedValueOnce(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${pendingResume.id}/complete`,
        headers: { Authorization: validToken() },
        payload: {},
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().message).toBe('File exceeds maximum allowed size of 5242880 bytes.');
      expect(res.json().details).toEqual({ actualSizeBytes: 5242881, maxSizeBytes: 5242880 });
      expect(vi.mocked(prisma.resume.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            errorCode: 'FILE_TOO_LARGE',
          }),
        })
      );
      expect(mockDeleteStorageObject).toHaveBeenCalledWith(pendingResume.storageKey);
    });

    it('detects and rejects clearly oversized actual S3 object (10 MiB / 10,485,760 bytes) on complete with 422', async () => {
      const pendingResume = {
        id: 'resume-clearly-oversized',
        userId: 'user-1',
        storageKey: 'resumes/user-1/resume-clearly-oversized.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        status: 'UPLOAD_PENDING',
      };
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(pendingResume as any);
      vi.mocked(prisma.resume.update).mockResolvedValueOnce({ ...pendingResume, status: 'FAILED' } as any);
      mockHeadStorageObject.mockResolvedValueOnce({ contentLength: 10 * 1024 * 1024 } as any); // 10 MiB
      mockDeleteStorageObject.mockResolvedValueOnce(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${pendingResume.id}/complete`,
        headers: { Authorization: validToken() },
        payload: {},
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().message).toBe('File exceeds maximum allowed size of 5242880 bytes.');
      expect(res.json().details).toEqual({ actualSizeBytes: 10485760, maxSizeBytes: 5242880 });
      expect(mockDeleteStorageObject).toHaveBeenCalledWith(pendingResume.storageKey);
    });

    it('detects and rejects file with invalid magic bytes (corrupted/masqueraded) with 422', async () => {
      const pendingResume = {
        id: 'resume-1',
        userId: 'user-1',
        storageKey: 'resumes/user-1/resume-1.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        status: 'UPLOAD_PENDING',
      };
      vi.mocked(prisma.resume.findUnique).mockResolvedValueOnce(pendingResume as any);
      vi.mocked(prisma.resume.update).mockResolvedValueOnce({ ...pendingResume, status: 'FAILED' } as any);
      mockHeadStorageObject.mockResolvedValueOnce({ contentLength: 1024 } as any);
      // Malicious file starting with shell script #!/bin/bash instead of %PDF-
      mockGetStorageObjectByteRange.mockResolvedValueOnce(Buffer.from('#!/bin/bash\nrm -rf /'));
      mockDeleteStorageObject.mockResolvedValueOnce(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${pendingResume.id}/complete`,
        headers: { Authorization: validToken() },
        payload: {},
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().message).toContain('signature validation failed');
      expect(mockDeleteStorageObject).toHaveBeenCalledWith(pendingResume.storageKey);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Rate-Limit Enforcement
  // -------------------------------------------------------------------------
  describe('Rate Limiting Protection', () => {
    it('enforces 10 req/min rate limit on /v1/resumes/upload-url returning 429', async () => {
      const token = `Bearer ${app.jwt.sign({ sub: 'rate-limited-user', email: 'rl@example.com' })}`;
      vi.mocked(prisma.resume.count).mockResolvedValue(0);
      mockCreatePresignedUploadUrl.mockResolvedValue({
        uploadUrl: 'http://localhost:9000/resumes/key',
        headers: {},
        expiresIn: 300,
      });

      let rateLimited = false;
      let statusCode = 200;

      for (let i = 0; i < 15; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/resumes/upload-url',
          headers: { Authorization: token },
          payload: {
            filename: `resume_${i}.pdf`,
            mimeType: 'application/pdf',
            sizeBytes: 1024,
          },
        });
        if (res.statusCode === 429) {
          rateLimited = true;
          statusCode = res.statusCode;
          break;
        }
      }

      expect(rateLimited).toBe(true);
      expect(statusCode).toBe(429);
    });
  });

  // -------------------------------------------------------------------------
  // 5. CORS Header Isolation
  // -------------------------------------------------------------------------
  describe('CORS Origin Isolation', () => {
    it('permits requests from localhost frontend origin (http://localhost:3000)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET',
        },
      });

      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('permits requests from loopback IP frontend origin (http://127.0.0.1:3000)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          Origin: 'http://127.0.0.1:3000',
          'Access-Control-Request-Method': 'GET',
        },
      });

      expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('rejects unneeded local port origins such as http://localhost:3001', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          Origin: 'http://localhost:3001',
          'Access-Control-Request-Method': 'GET',
        },
      });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects arbitrary untrusted external origins (http://evil.com)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          Origin: 'http://evil.com',
          'Access-Control-Request-Method': 'GET',
        },
      });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('permits requests without Origin header for standard non-browser API clients', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
