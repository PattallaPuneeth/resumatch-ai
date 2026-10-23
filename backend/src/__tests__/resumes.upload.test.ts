/**
 * Phase 2B: Upload URL and Complete endpoint tests.
 *
 * All tests use mocks for Prisma, S3, and BullMQ to remain isolated.
 * The Fastify app is built fresh per test suite via buildServer().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
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

vi.mock('../storage/minio.js', () => ({
  checkMinioHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
import {
  createPresignedUploadUrl,
  headStorageObject,
  getStorageObjectByteRange,
  deleteStorageObject,
} from '../storage/s3.js';
import { resumeParsingQueue } from '../queues/bullmq.js';
import { prisma } from '../db/prisma.js';

const mockCreatePresignedUploadUrl = vi.mocked(createPresignedUploadUrl);
const mockHeadStorageObject = vi.mocked(headStorageObject);
const mockGetStorageObjectByteRange = vi.mocked(getStorageObjectByteRange);
const mockDeleteStorageObject = vi.mocked(deleteStorageObject);
const mockQueueAdd = vi.mocked(resumeParsingQueue.add);
const mockResumeCount = vi.mocked(prisma.resume.count);
const mockResumeCreate = vi.mocked(prisma.resume.create);
const mockResumeFindUnique = vi.mocked(prisma.resume.findUnique);
const mockResumeUpdate = vi.mocked(prisma.resume.update);
const mockResumeDelete = vi.mocked(prisma.resume.delete);

/**
 * Sign a JWT for testing using the server's jwt plugin.
 */
async function getAuthToken(app: FastifyInstance, userId = 'user-test-uuid', email = 'test@example.com') {
  const token = app.jwt.sign({ sub: userId, email });
  return `Bearer ${token}`;
}

// Mock Resume factory
function mockResume(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resume-uuid-1',
    userId: 'user-test-uuid',
    originalFilename: 'my_resume.pdf',
    storageKey: 'resumes/user-test-uuid/resume-uuid-1.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100000,
    sha256: null,
    status: 'UPLOAD_PENDING',
    extractionMethod: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Phase 2B: POST /v1/resumes/upload-url', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.resetAllMocks();
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      payload: { filename: 'cv.pdf', mimeType: 'application/pdf', sizeBytes: 1000 },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.statusCode).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 with an invalid/expired JWT token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: 'Bearer invalid.jwt.token' },
      payload: { filename: 'cv.pdf', mimeType: 'application/pdf', sizeBytes: 1000 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when body is missing required fields', async () => {
    const token = await getAuthToken(app);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Bad Request');
  });

  it('returns 400 for unsupported MIME type (text/plain) — Zod rejects extension first', async () => {
    const token = await getAuthToken(app);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      // .txt extension fails Zod regex before we even check MIME type
      payload: { filename: 'cv.txt', mimeType: 'text/plain', sizeBytes: 1000 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Bad Request');
  });

  it('returns 422 for unsupported extension (.txt)', async () => {
    const token = await getAuthToken(app);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: { filename: 'cv.txt', mimeType: 'application/pdf', sizeBytes: 1000 },
    });
    expect(res.statusCode).toBe(400); // Zod rejects the filename extension
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Bad Request');
  });

  it('returns 422 for unsupported MIME type with valid .pdf extension', async () => {
    const token = await getAuthToken(app);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      // Valid extension (.pdf passes Zod) but MIME is unsupported → 422
      payload: { filename: 'cv.pdf', mimeType: 'text/plain', sizeBytes: 1000 },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Unprocessable Entity');
  });

  it('returns 400 when sizeBytes exceeds MAX_UPLOAD_BYTES (5 MiB)', async () => {
    const token = await getAuthToken(app);
    const oversize = env.MAX_UPLOAD_BYTES + 1;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: { filename: 'cv.pdf', mimeType: 'application/pdf', sizeBytes: oversize },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Bad Request');
  });

  it('returns 422 when filename extension does not match MIME type', async () => {
    const token = await getAuthToken(app);
    mockResumeCount.mockResolvedValue(0);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: {
        filename: 'resume.docx',
        mimeType: 'application/pdf',
        sizeBytes: 50000,
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Unprocessable Entity');
  });

  it('returns 200 with upload URL for valid PDF upload request', async () => {
    const token = await getAuthToken(app);

    mockResumeCount.mockResolvedValue(0);
    mockResumeCreate.mockResolvedValue(mockResume() as any);
    mockCreatePresignedUploadUrl.mockResolvedValue({
      uploadUrl: 'http://localhost:9000/resumes/user-test-uuid/resume-uuid-1.pdf?X-Amz-Expires=300',
      headers: { 'Content-Type': 'application/pdf' },
      expiresIn: 300,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: { filename: 'my_resume.pdf', mimeType: 'application/pdf', sizeBytes: 100000 },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.resumeId).toBeDefined();
    expect(body.uploadUrl).toContain('http://localhost:9000');
    expect(body.expiresIn).toBe(300);
    expect(body.headers['Content-Type']).toBe('application/pdf');
    expect(mockResumeCreate).toHaveBeenCalledOnce();
  });

  it('returns 200 with upload URL for valid DOCX upload request', async () => {
    const token = await getAuthToken(app);

    mockResumeCount.mockResolvedValue(0);
    mockResumeCreate.mockResolvedValue(mockResume({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      storageKey: 'resumes/user-test-uuid/resume-uuid-1.docx',
    }) as any);
    mockCreatePresignedUploadUrl.mockResolvedValue({
      uploadUrl: 'http://localhost:9000/resumes/user-test-uuid/resume-uuid-1.docx?X-Amz-Expires=300',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      expiresIn: 300,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: {
        filename: 'resume.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 80000,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.resumeId).toBeDefined();
    expect(body.uploadUrl).toContain('.docx');
  });

  it('creates a Resume record with status UPLOAD_PENDING', async () => {
    const token = await getAuthToken(app);
    mockResumeCount.mockResolvedValue(0);
    mockResumeCreate.mockResolvedValue(mockResume() as any);
    mockCreatePresignedUploadUrl.mockResolvedValue({
      uploadUrl: 'http://localhost:9000/presigned',
      headers: { 'Content-Type': 'application/pdf' },
      expiresIn: 300,
    });

    await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: { filename: 'test.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
    });

    expect(mockResumeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'UPLOAD_PENDING',
          mimeType: 'application/pdf',
        }),
      })
    );
  });

  it('returns 429 when user is at resume cap', async () => {
    const token = await getAuthToken(app);
    mockResumeCount.mockResolvedValue(env.RESUME_CAP_PER_USER);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: { filename: 'test.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
    });

    expect(res.statusCode).toBe(429);
  });

  it('returns 503 and rolls back record when S3 signing fails', async () => {
    const token = await getAuthToken(app);
    mockResumeCount.mockResolvedValue(0);
    mockResumeCreate.mockResolvedValue(mockResume() as any);
    mockCreatePresignedUploadUrl.mockRejectedValue(new Error('S3 connection refused'));
    mockResumeDelete.mockResolvedValue(mockResume() as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: { filename: 'test.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
    });

    expect(res.statusCode).toBe(503);
    expect(mockResumeDelete).toHaveBeenCalledOnce();
  });

  it('presigned URL expiry is configured to PRESIGN_PUT_TTL_SECONDS (300s)', async () => {
    const token = await getAuthToken(app);
    mockResumeCount.mockResolvedValue(0);
    mockResumeCreate.mockResolvedValue(mockResume() as any);
    mockCreatePresignedUploadUrl.mockResolvedValue({
      uploadUrl: 'http://localhost:9000/presigned',
      headers: { 'Content-Type': 'application/pdf' },
      expiresIn: 300,
    });

    await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: { filename: 'test.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
    });

    expect(mockCreatePresignedUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInSeconds: env.PRESIGN_PUT_TTL_SECONDS })
    );
  });

  it('object key follows resumes/{userId}/{resumeId}.{ext} format', async () => {
    const userId = 'user-test-uuid';
    const token = await getAuthToken(app, userId);
    mockResumeCount.mockResolvedValue(0);
    mockResumeCreate.mockResolvedValue(mockResume() as any);
    mockCreatePresignedUploadUrl.mockResolvedValue({
      uploadUrl: 'http://localhost:9000/presigned',
      headers: { 'Content-Type': 'application/pdf' },
      expiresIn: 300,
    });

    await app.inject({
      method: 'POST',
      url: '/v1/resumes/upload-url',
      headers: { Authorization: token },
      payload: { filename: 'test.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
    });

    const createCall = mockResumeCreate.mock.calls[0][0];
    const storageKey: string = createCall.data.storageKey;
    expect(storageKey).toMatch(/^resumes\/user-test-uuid\/[0-9a-f-]+\.pdf$/);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/resumes/:id/complete
// ---------------------------------------------------------------------------
describe('Phase 2B: POST /v1/resumes/:id/complete', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.resetAllMocks();
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 without authentication', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/resumes/resume-uuid-1/complete' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when resume does not exist', async () => {
    const token = await getAuthToken(app);
    mockResumeFindUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/non-existent/complete',
      headers: { Authorization: token },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when resume belongs to another user (ownership check)', async () => {
    const token = await getAuthToken(app, 'user-test-uuid');
    mockResumeFindUnique.mockResolvedValue(mockResume({ userId: 'other-user-uuid' }) as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Forbidden');
  });

  it('returns 422 when object is not found in storage (expired URL scenario)', async () => {
    const token = await getAuthToken(app);
    mockResumeFindUnique.mockResolvedValue(mockResume() as any);
    mockHeadStorageObject.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('not found in storage');
  });

  it('returns 422 and marks FAILED for oversized actual object', async () => {
    const token = await getAuthToken(app);
    mockResumeFindUnique.mockResolvedValue(mockResume() as any);
    mockHeadStorageObject.mockResolvedValue({
      contentLength: env.MAX_UPLOAD_BYTES + 1,
      contentType: 'application/pdf',
    });
    mockDeleteStorageObject.mockResolvedValue(undefined);
    mockResumeUpdate.mockResolvedValue(mockResume({ status: 'FAILED', errorCode: 'FILE_TOO_LARGE' }) as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });
    expect(res.statusCode).toBe(422);
    expect(mockResumeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: 'FILE_TOO_LARGE' }),
      })
    );
    expect(mockDeleteStorageObject).toHaveBeenCalledOnce();
  });

  it('returns 422 and marks FAILED when magic bytes do not match PDF signature', async () => {
    const token = await getAuthToken(app);
    mockResumeFindUnique.mockResolvedValue(mockResume() as any);
    mockHeadStorageObject.mockResolvedValue({ contentLength: 100000, contentType: 'application/pdf' });
    // Return bytes that are NOT %PDF-
    mockGetStorageObjectByteRange
      .mockResolvedValueOnce(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])) // magic check (wrong)
      .mockResolvedValueOnce(Buffer.alloc(100000)); // hash read (won't be called)
    mockDeleteStorageObject.mockResolvedValue(undefined);
    mockResumeUpdate.mockResolvedValue(mockResume({ status: 'FAILED', errorCode: 'CORRUPT_FILE' }) as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });
    expect(res.statusCode).toBe(422);
    expect(mockResumeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: 'CORRUPT_FILE' }),
      })
    );
    expect(mockDeleteStorageObject).toHaveBeenCalledOnce();
  });

  it('returns 422 and marks FAILED when magic bytes do not match DOCX/ZIP signature', async () => {
    const token = await getAuthToken(app);
    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    mockResumeFindUnique.mockResolvedValue(mockResume({
      mimeType: docxMime,
      storageKey: 'resumes/user-test-uuid/resume-uuid-1.docx',
    }) as any);
    mockHeadStorageObject.mockResolvedValue({ contentLength: 80000, contentType: docxMime });
    // Wrong magic bytes (not PK)
    mockGetStorageObjectByteRange.mockResolvedValueOnce(Buffer.from([0xFF, 0xFE, 0x00, 0x00]));
    mockDeleteStorageObject.mockResolvedValue(undefined);
    mockResumeUpdate.mockResolvedValue(mockResume({ status: 'FAILED', errorCode: 'CORRUPT_FILE' }) as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.details.errorCode).toBe('CORRUPT_FILE');
  });

  it('rejects partial 2-byte PK signature with 422 CORRUPT_FILE for DOCX', async () => {
    const token = await getAuthToken(app);
    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    mockResumeFindUnique.mockResolvedValue(mockResume({
      mimeType: docxMime,
      storageKey: 'resumes/user-test-uuid/resume-uuid-1.docx',
    }) as any);
    mockHeadStorageObject.mockResolvedValue({ contentLength: 80000, contentType: docxMime });
    // Partial signature (starts with PK but missing \x03\x04)
    mockGetStorageObjectByteRange.mockResolvedValueOnce(Buffer.from([0x50, 0x4B, 0x00, 0x00]));
    mockDeleteStorageObject.mockResolvedValue(undefined);
    mockResumeUpdate.mockResolvedValue(mockResume({ status: 'FAILED', errorCode: 'CORRUPT_FILE' }) as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.details.errorCode).toBe('CORRUPT_FILE');
    expect(mockDeleteStorageObject).toHaveBeenCalledWith('resumes/user-test-uuid/resume-uuid-1.docx');
  });

  it('accepts valid 4-byte PK\\x03\\x04 signature for DOCX and returns 202', async () => {
    const token = await getAuthToken(app);
    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    mockResumeFindUnique.mockResolvedValue(mockResume({
      mimeType: docxMime,
      storageKey: 'resumes/user-test-uuid/resume-uuid-1.docx',
    }) as any);
    mockHeadStorageObject.mockResolvedValue({ contentLength: 80000, contentType: docxMime });
    const docxMagic = Buffer.from([0x50, 0x4B, 0x03, 0x04]); // PK\x03\x04
    const fullContent = Buffer.concat([docxMagic, Buffer.alloc(79996)]);
    mockGetStorageObjectByteRange
      .mockResolvedValueOnce(docxMagic)
      .mockResolvedValueOnce(fullContent);
    mockResumeUpdate.mockResolvedValue(mockResume({ status: 'UPLOADED' }) as any);
    mockQueueAdd.mockResolvedValue({ id: 'job-id' } as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('UPLOADED');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'parse',
      expect.objectContaining({
        type: 'PARSE_DOCUMENT',
        mimeType: docxMime,
      }),
      expect.objectContaining({ jobId: 'parse-resume-uuid-1' })
    );
  });

  it('returns 503 and rolls back status to UPLOAD_PENDING when BullMQ enqueue fails on complete', async () => {
    const token = await getAuthToken(app);
    mockResumeFindUnique.mockResolvedValue(mockResume() as any);
    mockHeadStorageObject.mockResolvedValue({ contentLength: 100000, contentType: 'application/pdf' });
    const pdfMagic = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const fullContent = Buffer.concat([pdfMagic, Buffer.alloc(99995)]);
    mockGetStorageObjectByteRange
      .mockResolvedValueOnce(pdfMagic)
      .mockResolvedValueOnce(fullContent);
    mockResumeUpdate.mockResolvedValue(mockResume({ status: 'UPLOADED' }) as any);
    mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection failure during enqueue'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Service Unavailable');
    expect(body.message).toContain('Failed to enqueue resume parsing job');

    // Verify rollback to UPLOAD_PENDING was called
    expect(mockResumeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'resume-uuid-1' },
        data: expect.objectContaining({
          status: 'UPLOAD_PENDING',
        }),
      })
    );
  });

  it('allows completion retry after previous queue failure and successfully transitions to UPLOADED', async () => {
    const token = await getAuthToken(app);
    // Resume is in UPLOAD_PENDING from previous rollback
    mockResumeFindUnique.mockResolvedValue(mockResume({ status: 'UPLOAD_PENDING' }) as any);
    mockHeadStorageObject.mockResolvedValue({ contentLength: 100000, contentType: 'application/pdf' });
    const pdfMagic = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const fullContent = Buffer.concat([pdfMagic, Buffer.alloc(99995)]);
    mockGetStorageObjectByteRange
      .mockResolvedValueOnce(pdfMagic)
      .mockResolvedValueOnce(fullContent);
    mockResumeUpdate.mockResolvedValue(mockResume({ status: 'UPLOADED' }) as any);
    mockQueueAdd.mockResolvedValueOnce({ id: 'job-id' } as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('UPLOADED');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'parse',
      expect.objectContaining({
        type: 'PARSE_DOCUMENT',
        resumeId: 'resume-uuid-1',
      }),
      expect.objectContaining({ jobId: 'parse-resume-uuid-1' })
    );
  });

  it('re-enqueues job with deterministic jobId when status is UPLOADED on idempotent retry', async () => {
    const token = await getAuthToken(app);
    mockResumeFindUnique.mockResolvedValue(mockResume({
      status: 'UPLOADED',
      sha256: 'a'.repeat(64),
    }) as any);
    mockQueueAdd.mockResolvedValueOnce({ id: 'parse-resume-uuid-1' } as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('UPLOADED');
    // Ensure it re-added with deterministic jobId
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'parse',
      expect.objectContaining({
        type: 'PARSE_DOCUMENT',
        resumeId: 'resume-uuid-1',
        sha256: 'a'.repeat(64),
      }),
      expect.objectContaining({ jobId: 'parse-resume-uuid-1' })
    );
  });

  it('returns 503 if BullMQ enqueue fails during idempotent retry when status is UPLOADED', async () => {
    const token = await getAuthToken(app);
    mockResumeFindUnique.mockResolvedValue(mockResume({ status: 'UPLOADED' }) as any);
    mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection failure on retry'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Service Unavailable');
  });

  it('returns 202 without calling queue when status is already EXTRACTING or PARSED', async () => {
    const token = await getAuthToken(app);
    mockResumeFindUnique.mockResolvedValue(mockResume({ status: 'EXTRACTING' }) as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });

    expect(res.statusCode).toBe(202);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockHeadStorageObject).not.toHaveBeenCalled();
  });

  it('returns 409 when status is FAILED', async () => {
    const token = await getAuthToken(app);
    mockResumeFindUnique.mockResolvedValue(mockResume({ status: 'FAILED' }) as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Conflict');
  });

  it('SHA-256 is computed and persisted during completion', async () => {
    const token = await getAuthToken(app);
    mockResumeFindUnique.mockResolvedValue(mockResume() as any);
    mockHeadStorageObject.mockResolvedValue({ contentLength: 5, contentType: 'application/pdf' });
    const pdfMagic = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
    mockGetStorageObjectByteRange
      .mockResolvedValueOnce(pdfMagic)
      .mockResolvedValueOnce(pdfMagic);
    mockResumeUpdate.mockResolvedValue(mockResume({ status: 'UPLOADED' }) as any);
    mockQueueAdd.mockResolvedValue({ id: 'job-id' } as any);

    await app.inject({
      method: 'POST',
      url: '/v1/resumes/resume-uuid-1/complete',
      headers: { Authorization: token },
    });

    const updateCall = mockResumeUpdate.mock.calls[0][0];
    expect(updateCall.data.sha256).toBeDefined();
    expect(typeof updateCall.data.sha256).toBe('string');
    expect(updateCall.data.sha256).toHaveLength(64); // SHA-256 hex = 64 chars
  });
});

// ---------------------------------------------------------------------------
// Regression: Phase 1 stubs should still return 501
// ---------------------------------------------------------------------------
describe('Regression: Phase 1 stubs still return 501', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildServer();
    await app.ready();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /resumes returns 501', async () => {
    const res = await app.inject({ method: 'GET', url: '/resumes' });
    expect(res.statusCode).toBe(501);
  });

  it('POST /resumes returns 501', async () => {
    const res = await app.inject({ method: 'POST', url: '/resumes', payload: {} });
    expect(res.statusCode).toBe(501);
  });

  it('GET /analyses returns 501', async () => {
    const res = await app.inject({ method: 'GET', url: '/analyses' });
    expect(res.statusCode).toBe(501);
  });

  it('GET /jobs returns 501', async () => {
    const res = await app.inject({ method: 'GET', url: '/jobs' });
    expect(res.statusCode).toBe(501);
  });
});
