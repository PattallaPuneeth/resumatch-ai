/**
 * Phase 2D: Resume Lifecycle Tests
 *
 * Tests:
 * 1. GET /v1/resumes/:id: status retrieval & metadata
 * 2. GET /v1/resumes/:id: parsed data returned ONLY when status == 'PARSED'
 * 3. GET /v1/resumes/:id: safe error details when status == 'FAILED'
 * 4. GET /v1/resumes/:id/download-url: presigned download URL generation
 * 5. GET /v1/resumes/:id/download-url: rejects UPLOAD_PENDING or missing storage objects
 * 6. DELETE /v1/resumes/:id: queue job removal, S3 deletion, DB cascade, and AuditLog
 * 7. GET /v1/resumes: list authenticated user's resumes
 * 8. Authentication & Authorization: 401 unauthenticated, 403 cross-tenant isolation
 * 9. Resilience: missing objects, repeated deletion, and graceful degradation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
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
      add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
      getJob: vi.fn(),
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
import {
  createPresignedDownloadUrl,
  headStorageObject,
  deleteStorageObject,
} from '../storage/s3.js';
import { resumeParsingQueue } from '../queues/bullmq.js';
import { prisma } from '../db/prisma.js';

const mockCreatePresignedDownloadUrl = vi.mocked(createPresignedDownloadUrl);
const mockHeadStorageObject = vi.mocked(headStorageObject);
const mockDeleteStorageObject = vi.mocked(deleteStorageObject);
const mockQueueGetJob = vi.mocked(resumeParsingQueue.getJob);
const mockResumeFindUnique = vi.mocked(prisma.resume.findUnique);
const mockResumeFindMany = vi.mocked(prisma.resume.findMany);
const mockResumeDelete = vi.mocked(prisma.resume.delete);
const mockAuditLogCreate = vi.mocked(prisma.auditLog.create);
const mockTransaction = vi.mocked(prisma.$transaction);

async function getAuthToken(
  app: FastifyInstance,
  userId = 'user-owner-uuid',
  email = 'owner@example.com'
) {
  const token = app.jwt.sign({ sub: userId, email });
  return `Bearer ${token}`;
}

function createMockResume(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resume-123',
    userId: 'user-owner-uuid',
    originalFilename: 'Jane_Doe_Resume.pdf',
    storageKey: 'resumes/user-owner-uuid/resume-123.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 102400,
    sha256: 'a1b2c3d4e5f6',
    status: 'PARSED',
    extractionMethod: 'TEXT_LAYER',
    errorCode: null,
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:01:00.000Z'),
    parsedResume: {
      id: 'parsed-123',
      resumeId: 'resume-123',
      rawText: 'Jane Doe Software Engineer skills Python TypeScript',
      candidateName: 'Jane Doe',
      contactInfo: { email: 'jane@example.com', phone: '+1234567890' },
      summary: 'Experienced backend engineer',
      skills: [{ name: 'Python', category: 'languages', confidence: 1.0, startChar: 38, endChar: 44 }],
      experience: [{ title: 'Staff Engineer', company: 'Tech Corp', startChar: 0, endChar: 20 }],
      education: [{ degree: 'B.S. CS', institution: 'MIT', startChar: 0, endChar: 10 }],
      certifications: [],
      pageCount: 1,
      atsScore: 92.5,
      atsHazards: [],
      parsingMetadata: { parser: 'PyMuPDF' },
      createdAt: new Date('2026-01-01T00:01:00.000Z'),
      updatedAt: new Date('2026-01-01T00:01:00.000Z'),
    },
    ...overrides,
  };
}

describe('Phase 2D: Resume Lifecycle Endpoints', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildServer();

    // Default mock transaction to execute callback immediately with mock tx
    mockTransaction.mockImplementation(async (callback: any) => {
      const tx = {
        resume: { delete: mockResumeDelete },
        auditLog: { create: mockAuditLogCreate },
      };
      return callback(tx);
    });
  });

  afterEach(async () => {
    await app.close();
  });

  // =========================================================================
  // 1. GET /v1/resumes/:id (Status and Parsed Result Retrieval)
  // =========================================================================
  describe('GET /v1/resumes/:id', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/resume-123',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when resume does not exist', async () => {
      mockResumeFindUnique.mockResolvedValue(null);
      const auth = await getAuthToken(app);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/nonexistent-id',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not Found');
      expect(body.message).toBe('Resume not found');
    });

    it('returns 404 Not Found on cross-user tenant violation', async () => {
      mockResumeFindUnique.mockResolvedValue(createMockResume({ userId: 'other-user-uuid' }) as any);
      const auth = await getAuthToken(app, 'attacker-user-uuid');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not Found');
      expect(body.message).toBe('Resume not found');
    });

    it('returns 200 with complete parsedResume data when status is PARSED', async () => {
      const mock = createMockResume({ status: 'PARSED' });
      mockResumeFindUnique.mockResolvedValue(mock as any);
      const auth = await getAuthToken(app);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('resume-123');
      expect(body.status).toBe('PARSED');
      expect(body.extractionMethod).toBe('TEXT_LAYER');
      expect(body.parsedResume).toBeDefined();
      expect(body.parsedResume.candidateName).toBe('Jane Doe');
      expect(body.parsedResume.atsScore).toBe(92.5);
      expect(body.parsedResume.skills).toHaveLength(1);
    });

    it('returns 200 with parsedResume: null when status is EXTRACTING or UPLOADED', async () => {
      const mock = createMockResume({ status: 'EXTRACTING' });
      mockResumeFindUnique.mockResolvedValue(mock as any);
      const auth = await getAuthToken(app);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('EXTRACTING');
      expect(body.parsedResume).toBeNull();
    });

    it('returns 200 with safe errorCode and errorMessage when status is FAILED', async () => {
      const mock = createMockResume({
        status: 'FAILED',
        errorCode: 'TEXT_TOO_SHORT_AFTER_OCR',
        errorMessage: 'OCR yielded insufficient readable text.',
        parsedResume: null,
      });
      mockResumeFindUnique.mockResolvedValue(mock as any);
      const auth = await getAuthToken(app);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('FAILED');
      expect(body.errorCode).toBe('TEXT_TOO_SHORT_AFTER_OCR');
      expect(body.errorMessage).toBe('OCR yielded insufficient readable text.');
      expect(body.parsedResume).toBeNull();
    });
  });

  // =========================================================================
  // 2. GET /v1/resumes/:id/download-url (Presigned Download URL)
  // =========================================================================
  describe('GET /v1/resumes/:id/download-url', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/resume-123/download-url',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when resume does not exist', async () => {
      mockResumeFindUnique.mockResolvedValue(null);
      const auth = await getAuthToken(app);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/nonexistent-id/download-url',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 Not Found when requesting download URL for another user resume', async () => {
      mockResumeFindUnique.mockResolvedValue(createMockResume({ userId: 'other-user' }) as any);
      const auth = await getAuthToken(app, 'attacker-user');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/resume-123/download-url',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 422 if resume is still in UPLOAD_PENDING state', async () => {
      mockResumeFindUnique.mockResolvedValue(createMockResume({ status: 'UPLOAD_PENDING' }) as any);
      const auth = await getAuthToken(app);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/resume-123/download-url',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('still pending');
    });

    it('returns 404 if storage object is missing', async () => {
      mockResumeFindUnique.mockResolvedValue(createMockResume({ status: 'PARSED' }) as any);
      mockHeadStorageObject.mockResolvedValue(null);
      const auth = await getAuthToken(app);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/resume-123/download-url',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('not found in storage');
    });

    it('returns 200 with presigned download URL when object exists', async () => {
      mockResumeFindUnique.mockResolvedValue(createMockResume({ status: 'PARSED' }) as any);
      mockHeadStorageObject.mockResolvedValue({ contentLength: 102400 });
      mockCreatePresignedDownloadUrl.mockResolvedValue({
        downloadUrl: 'http://localhost:9000/resumes/user-owner-uuid/resume-123.pdf?X-Amz-Signature=xyz',
        expiresIn: 300,
      });

      const auth = await getAuthToken(app);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes/resume-123/download-url',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.resumeId).toBe('resume-123');
      expect(body.downloadUrl).toContain('X-Amz-Signature=xyz');
      expect(body.expiresIn).toBe(300);
      expect(mockCreatePresignedDownloadUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          storageKey: 'resumes/user-owner-uuid/resume-123.pdf',
          originalFilename: 'Jane_Doe_Resume.pdf',
        })
      );
    });
  });

  // =========================================================================
  // 3. DELETE /v1/resumes/:id (Cascade Deletion & AuditLog)
  // =========================================================================
  describe('DELETE /v1/resumes/:id', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/resume-123',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when resume does not exist', async () => {
      mockResumeFindUnique.mockResolvedValue(null);
      const auth = await getAuthToken(app);

      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/nonexistent-id',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 Not Found when attempting to delete another user resume', async () => {
      mockResumeFindUnique.mockResolvedValue(createMockResume({ userId: 'other-user' }) as any);
      const auth = await getAuthToken(app, 'attacker-user');

      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(404);
    });

    it('successfully deletes resume: cancels queue job, deletes S3 object, deletes DB record, writes AuditLog', async () => {
      mockResumeFindUnique.mockResolvedValue(createMockResume() as any);
      const mockJobRemove = vi.fn().mockResolvedValue(undefined);
      mockQueueGetJob.mockResolvedValue({ id: 'parse-resume-123', remove: mockJobRemove } as any);
      mockDeleteStorageObject.mockResolvedValue(undefined);
      mockResumeDelete.mockResolvedValue({ id: 'resume-123' } as any);
      mockAuditLogCreate.mockResolvedValue({ id: 'audit-1' } as any);

      const auth = await getAuthToken(app);
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.message).toBe('Resume deleted successfully');
      expect(body.id).toBe('resume-123');

      // 1. Queue job removal
      expect(mockQueueGetJob).toHaveBeenCalledWith('parse-resume-123');
      expect(mockJobRemove).toHaveBeenCalled();

      // 2. Storage object deletion
      expect(mockDeleteStorageObject).toHaveBeenCalledWith('resumes/user-owner-uuid/resume-123.pdf');

      // 3. Database deletion inside transaction
      expect(mockResumeDelete).toHaveBeenCalledWith({ where: { id: 'resume-123' } });

      // 4. AuditLog creation
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-owner-uuid',
            action: 'RESUME_DELETE',
            entityType: 'Resume',
            entityId: 'resume-123',
          }),
        })
      );
    });

    it('handles repeated deletion cleanly by returning 404 on second call', async () => {
      // First call: exists and deletes
      mockResumeFindUnique.mockResolvedValueOnce(createMockResume() as any);
      // Second call: does not exist
      mockResumeFindUnique.mockResolvedValueOnce(null);

      const auth = await getAuthToken(app);

      const firstRes = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });
      expect(firstRes.statusCode).toBe(200);

      const secondRes = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });
      expect(secondRes.statusCode).toBe(404);
    });

    it('aborts deletion with 503 and preserves DB record when storage deletion fails', async () => {
      mockResumeFindUnique.mockResolvedValue(createMockResume() as any);
      mockQueueGetJob.mockResolvedValue(undefined);
      mockDeleteStorageObject.mockRejectedValue(new Error('S3 connection reset'));

      const auth = await getAuthToken(app);
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });

      // Must return 503 Service Unavailable
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('Storage service temporarily unavailable');

      // Crucial: database delete MUST NOT be called so the record is retained and not orphaned
      expect(mockResumeDelete).not.toHaveBeenCalled();

      // Durable audit trail: RESUME_DELETE_FAILED must be recorded
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-owner-uuid',
            action: 'RESUME_DELETE_FAILED',
            entityType: 'Resume',
            entityId: 'resume-123',
            details: expect.objectContaining({
              stage: 'STORAGE_DELETION',
            }),
          }),
        })
      );
    });

    it('handles retry after storage deletion failure and completes deletion cleanly', async () => {
      const auth = await getAuthToken(app);

      // Attempt 1: Storage failure
      mockResumeFindUnique.mockResolvedValueOnce(createMockResume() as any);
      mockDeleteStorageObject.mockRejectedValueOnce(new Error('S3 network glitch'));

      const firstRes = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });
      expect(firstRes.statusCode).toBe(503);
      expect(mockResumeDelete).not.toHaveBeenCalled();

      // Attempt 2: Storage recovers, retry succeeds
      mockResumeFindUnique.mockResolvedValueOnce(createMockResume() as any);
      mockDeleteStorageObject.mockResolvedValueOnce(undefined);
      mockResumeDelete.mockResolvedValueOnce({ id: 'resume-123' } as any);
      mockAuditLogCreate.mockResolvedValueOnce({ id: 'audit-2' } as any);

      const retryRes = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });
      expect(retryRes.statusCode).toBe(200);
      expect(mockResumeDelete).toHaveBeenCalledWith({ where: { id: 'resume-123' } });
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'RESUME_DELETE',
          }),
        })
      );
    });

    it('handles database deletion failure after storage deletion with retryable 500 error', async () => {
      mockResumeFindUnique.mockResolvedValue(createMockResume() as any);
      mockQueueGetJob.mockResolvedValue(undefined);
      mockDeleteStorageObject.mockResolvedValue(undefined);
      mockTransaction.mockRejectedValueOnce(new Error('Postgres connection terminated'));

      const auth = await getAuthToken(app);
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('failed to complete database record removal');
    });

    it('handles BullMQ job removal failure gracefully without blocking deletion', async () => {
      mockResumeFindUnique.mockResolvedValue(createMockResume() as any);
      mockQueueGetJob.mockResolvedValue({
        id: 'parse-resume-123',
        remove: vi.fn().mockRejectedValue(new Error('Job locked by worker')),
      } as any);
      mockDeleteStorageObject.mockResolvedValue(undefined);
      mockResumeDelete.mockResolvedValue({ id: 'resume-123' } as any);
      mockAuditLogCreate.mockResolvedValue({ id: 'audit-1' } as any);

      const auth = await getAuthToken(app);
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/resumes/resume-123',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(200);
      expect(mockDeleteStorageObject).toHaveBeenCalled();
      expect(mockResumeDelete).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. GET /v1/resumes (List User Resumes)
  // =========================================================================
  describe('GET /v1/resumes', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with list of resumes scoped to authenticated user', async () => {
      const resumeList = [
        {
          id: 'res-1',
          originalFilename: 'resume1.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 50000,
          status: 'PARSED',
          extractionMethod: 'TEXT_LAYER',
          errorCode: null,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'res-2',
          originalFilename: 'resume2.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 70000,
          status: 'FAILED',
          extractionMethod: null,
          errorCode: 'CORRUPT_FILE',
          errorMessage: 'Corrupt docx file.',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      mockResumeFindMany.mockResolvedValue(resumeList as any);

      const auth = await getAuthToken(app, 'my-user-uuid');
      const res = await app.inject({
        method: 'GET',
        url: '/v1/resumes',
        headers: { authorization: auth },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.resumes).toHaveLength(2);
      expect(mockResumeFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'my-user-uuid' },
          orderBy: { createdAt: 'desc' },
        })
      );
    });
  });
});
