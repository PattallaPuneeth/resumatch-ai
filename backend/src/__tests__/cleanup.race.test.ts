/**
 * Cleanup / Completion Concurrency & Race Condition Regression Tests
 *
 * Verifies synchronization invariants between cleanupStaleUploadPending()
 * and handleCompleteUpload() for the same resume:
 *
 * 1. Completion races with stale cleanup for the same resume.
 * 2. Cleanup wins coordination first: completion must not successfully complete
 *    a resume whose object cleanup has claimed/deleted.
 * 3. Completion wins coordination first: cleanup must yield immediately and
 *    preserve both the storage object and database row.
 * 4. Storage deletion failure in cleanup: database record is preserved,
 *    audit failure recorded, and candidate remains retryable.
 * 5. Lock acquisition or transaction failure does not falsely report successful cleanup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module Mocks
// ---------------------------------------------------------------------------
const {
  mockResumeFindMany,
  mockResumeFindUnique,
  mockResumeUpdate,
  mockResumeDelete,
  mockAuditLogCreate,
  mockTransaction,
  mockDeleteStorageObject,
  mockHeadStorageObject,
  mockGetStorageObjectByteRange,
  mockQueueAdd,
} = vi.hoisted(() => ({
  mockResumeFindMany: vi.fn(),
  mockResumeFindUnique: vi.fn(),
  mockResumeUpdate: vi.fn(),
  mockResumeDelete: vi.fn(),
  mockAuditLogCreate: vi.fn(),
  mockTransaction: vi.fn(),
  mockDeleteStorageObject: vi.fn(),
  mockHeadStorageObject: vi.fn(),
  mockGetStorageObjectByteRange: vi.fn(),
  mockQueueAdd: vi.fn().mockResolvedValue({ id: 'job-1' }),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    resume: {
      findMany: mockResumeFindMany,
      findUnique: mockResumeFindUnique,
      update: mockResumeUpdate,
      delete: mockResumeDelete,
    },
    auditLog: {
      create: mockAuditLogCreate,
    },
    $transaction: mockTransaction,
  },
  checkDatabaseHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

vi.mock('../storage/s3.js', () => ({
  deleteStorageObject: mockDeleteStorageObject,
  headStorageObject: mockHeadStorageObject,
  getStorageObjectByteRange: mockGetStorageObjectByteRange,
  listStorageObjects: vi.fn(),
}));

vi.mock('../queues/bullmq.js', () => ({
  resumeParsingQueue: {
    add: mockQueueAdd,
    getJob: vi.fn().mockResolvedValue(null),
  },
}));

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

import { cleanupStaleUploadPending } from '../services/cleanupService.js';
import { handleCompleteUpload, handleDeleteResume } from '../routes/resumeController.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

describe('Cleanup / Completion Coordination Race Remediation', () => {
  const resumeId = 'race-resume-uuid-1';
  const userId = 'race-user-uuid-1';
  const storageKey = `resumes/${userId}/${resumeId}.pdf`;
  const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours old

  beforeEach(() => {
    vi.clearAllMocks();

    mockAuditLogCreate.mockResolvedValue({ id: 'audit-log-1' });
    mockDeleteStorageObject.mockResolvedValue(undefined);
    mockHeadStorageObject.mockResolvedValue({ contentLength: 1024 });
    mockGetStorageObjectByteRange.mockResolvedValue(Buffer.from('%PDF-1.7 mock content'));
    mockResumeDelete.mockResolvedValue({ id: resumeId });
    mockResumeUpdate.mockResolvedValue({ id: resumeId, status: 'UPLOADED' });
    mockQueueAdd.mockResolvedValue({ id: `parse-${resumeId}` });
  });

  function createMockRequestReply() {
    const request = {
      user: { sub: userId },
      params: { id: resumeId },
      id: 'req-race-1',
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as FastifyRequest<{ Params: { id: string } }>;

    let sentStatus = 200;
    let sentPayload: any = null;

    const reply = {
      status(code: number) {
        sentStatus = code;
        return this;
      },
      send(payload: any) {
        sentPayload = payload;
        return this;
      },
      getStatus: () => sentStatus,
      getPayload: () => sentPayload,
    } as unknown as FastifyReply & { getStatus: () => number; getPayload: () => any };

    return { request, reply };
  }

  // -------------------------------------------------------------------------
  // Test 1: Cleanup claims lock first; completion must not complete deleted resume
  // -------------------------------------------------------------------------
  it('Scenario 1: Cleanup wins lock first -> Completion cannot complete a claimed/deleted resume', async () => {
    // Candidates query returns the stale pending resume
    mockResumeFindMany.mockResolvedValue([
      {
        id: resumeId,
        userId,
        storageKey,
        originalFilename: 'test.pdf',
        createdAt: staleDate,
        status: 'UPLOAD_PENDING',
      },
    ]);

    // Active record in DB before cleanup commits
    let recordInDatabase = true;

    // Simulate cleanup acquiring lock and deleting the resume
    mockTransaction.mockImplementation(async (callback: any) => {
      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
        $executeRaw: vi.fn().mockResolvedValue(1),
        resume: {
          findUnique: vi.fn().mockImplementation(async ({ where }) => {
            if (where.id === resumeId && recordInDatabase) {
              return {
                id: resumeId,
                userId,
                storageKey,
                originalFilename: 'test.pdf',
                createdAt: staleDate,
                status: 'UPLOAD_PENDING',
              };
            }
            return null;
          }),
          delete: vi.fn().mockImplementation(async () => {
            recordInDatabase = false;
            return { id: resumeId };
          }),
          update: mockResumeUpdate,
        },
        auditLog: {
          create: mockAuditLogCreate,
        },
      };
      return callback(mockTx);
    });

    // Run cleanup
    const cleanupStats = await cleanupStaleUploadPending({
      cutoffDate: new Date(),
    });

    expect(cleanupStats.cleaned).toBe(1);
    expect(mockDeleteStorageObject).toHaveBeenCalledWith(storageKey);
    expect(recordInDatabase).toBe(false);

    // Now completion arrives for the resume that cleanup claimed & deleted
    const { request, reply } = createMockRequestReply();
    await handleCompleteUpload(request, reply);

    // Completion MUST return 404 Not Found and MUST NOT transition to UPLOADED or enqueue a job
    expect(reply.getStatus()).toBe(404);
    expect(reply.getPayload().error).toBe('Not Found');
    expect(mockResumeUpdate).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: Completion wins coordination first; cleanup yields and preserves object
  // -------------------------------------------------------------------------
  it('Scenario 2: Completion wins lock first -> Cleanup yields immediately and preserves object + row', async () => {
    // When cleanup tries to acquire the coordination lock, it returns false (held by completion)
    mockResumeFindMany.mockResolvedValue([
      {
        id: resumeId,
        userId,
        storageKey,
        originalFilename: 'test.pdf',
        createdAt: staleDate,
        status: 'UPLOAD_PENDING',
      },
    ]);

    mockTransaction.mockImplementation(async (callback: any) => {
      const mockTx = {
        // tryAcquire returns acquired: false
        $queryRaw: vi.fn().mockResolvedValue([{ acquired: false }]),
        $executeRaw: vi.fn().mockResolvedValue(1),
        resume: {
          findUnique: vi.fn(),
          delete: mockResumeDelete,
          update: mockResumeUpdate,
        },
        auditLog: {
          create: mockAuditLogCreate,
        },
      };
      return callback(mockTx);
    });

    const cleanupStats = await cleanupStaleUploadPending({
      cutoffDate: new Date(),
    });

    // Cleanup must yield immediately without deleting storage object or DB row
    expect(cleanupStats.skipped).toBe(1);
    expect(cleanupStats.cleaned).toBe(0);
    expect(mockDeleteStorageObject).not.toHaveBeenCalled();
    expect(mockResumeDelete).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: Concurrent completion updates status before cleanup inspects; cleanup yields
  // -------------------------------------------------------------------------
  it('Scenario 3: Completion transitions status to UPLOADED -> Cleanup inspects and skips safely', async () => {
    mockResumeFindMany.mockResolvedValue([
      {
        id: resumeId,
        userId,
        storageKey,
        originalFilename: 'test.pdf',
        createdAt: staleDate,
        status: 'UPLOAD_PENDING',
      },
    ]);

    // Cleanup acquires lock, but fresh read shows completion already changed status to UPLOADED
    mockTransaction.mockImplementation(async (callback: any) => {
      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
        $executeRaw: vi.fn().mockResolvedValue(1),
        resume: {
          findUnique: vi.fn().mockResolvedValue({
            id: resumeId,
            userId,
            storageKey,
            originalFilename: 'test.pdf',
            createdAt: staleDate,
            status: 'UPLOADED', // Completed concurrently!
          }),
          delete: mockResumeDelete,
          update: mockResumeUpdate,
        },
        auditLog: {
          create: mockAuditLogCreate,
        },
      };
      return callback(mockTx);
    });

    const cleanupStats = await cleanupStaleUploadPending({
      cutoffDate: new Date(),
    });

    expect(cleanupStats.skipped).toBe(1);
    expect(cleanupStats.cleaned).toBe(0);
    expect(mockDeleteStorageObject).not.toHaveBeenCalled();
    expect(mockResumeDelete).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4: Storage deletion fails; pending record remains retryable in DB
  // -------------------------------------------------------------------------
  it('Scenario 4: Storage deletion failure retains DB record and logs RESUME_CLEANUP_STALE_PENDING_FAILED', async () => {
    mockResumeFindMany.mockResolvedValue([
      {
        id: resumeId,
        userId,
        storageKey,
        originalFilename: 'test.pdf',
        createdAt: staleDate,
        status: 'UPLOAD_PENDING',
      },
    ]);

    // Head says object exists
    mockHeadStorageObject.mockResolvedValue({ contentLength: 2048 });
    // Storage deletion fails with network error
    mockDeleteStorageObject.mockRejectedValue(new Error('S3 500 Internal Error'));

    mockTransaction.mockImplementation(async (callback: any) => {
      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
        $executeRaw: vi.fn().mockResolvedValue(1),
        resume: {
          findUnique: vi.fn().mockResolvedValue({
            id: resumeId,
            userId,
            storageKey,
            originalFilename: 'test.pdf',
            createdAt: staleDate,
            status: 'UPLOAD_PENDING',
          }),
          delete: mockResumeDelete,
          update: mockResumeUpdate,
        },
        auditLog: {
          create: mockAuditLogCreate,
        },
      };
      return callback(mockTx);
    });

    const cleanupStats = await cleanupStaleUploadPending({
      cutoffDate: new Date(),
    });

    // Must report failed: 1 and cleaned: 0
    expect(cleanupStats.failed).toBe(1);
    expect(cleanupStats.cleaned).toBe(0);

    // Database record must NOT be deleted
    expect(mockResumeDelete).not.toHaveBeenCalled();

    // Audit log must record the failure details for observability and retry
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId,
          action: 'RESUME_CLEANUP_STALE_PENDING_FAILED',
          entityId: resumeId,
          details: expect.objectContaining({
            storageKey,
            stage: 'STORAGE_DELETION',
          }),
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: Transaction abort does not falsely report successful cleanup
  // -------------------------------------------------------------------------
  it('Scenario 5: Transaction abort or failure does not falsely increment cleaned counter', async () => {
    mockResumeFindMany.mockResolvedValue([
      {
        id: resumeId,
        userId,
        storageKey,
        originalFilename: 'test.pdf',
        createdAt: staleDate,
        status: 'UPLOAD_PENDING',
      },
    ]);

    // Transaction throws database error
    mockTransaction.mockRejectedValue(new Error('PostgreSQL transaction serialization failure'));

    const cleanupStats = await cleanupStaleUploadPending({
      cutoffDate: new Date(),
    });

    // Cleanup counter must remain 0 and failed counter incremented
    expect(cleanupStats.cleaned).toBe(0);
    expect(cleanupStats.failed).toBe(1);
    expect(cleanupStats.skipped).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 6: Queue failure rollback acquires lock and refreshes createdAt
  // -------------------------------------------------------------------------
  it('Scenario 6: Queue failure rollback acquires coordination lock and refreshes createdAt to protect retries', async () => {
    // Complete validation succeeds, but BullMQ enqueue fails
    mockQueueAdd.mockRejectedValueOnce(new Error('BullMQ connection failure'));

    mockTransaction.mockImplementation(async (callback: any) => {
      const mockTx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        resume: {
          findUnique: vi.fn().mockResolvedValue({
            id: resumeId,
            userId,
            storageKey,
            originalFilename: 'test.pdf',
            mimeType: 'application/pdf',
            createdAt: staleDate,
            status: 'UPLOAD_PENDING',
          }),
          update: mockResumeUpdate,
        },
      };
      return callback(mockTx);
    });

    const { request, reply } = createMockRequestReply();
    await handleCompleteUpload(request, reply);

    expect(reply.getStatus()).toBe(503);
    expect(reply.getPayload().error).toBe('Service Unavailable');

    // Verify rollback was called with UPLOAD_PENDING and fresh createdAt
    expect(mockResumeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: resumeId },
        data: expect.objectContaining({
          status: 'UPLOAD_PENDING',
          createdAt: expect.any(Date),
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // Test 7: Queue failure rollback does NOT overwrite progressed lifecycle state
  // -------------------------------------------------------------------------
  it('Scenario 7: Queue failure rollback does NOT overwrite newer status (e.g. EXTRACTING/PARSED)', async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error('BullMQ connection failure'));

    let callCount = 0;
    mockTransaction.mockImplementation(async (callback: any) => {
      callCount++;
      const mockTx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        resume: {
          findUnique: vi.fn().mockImplementation(async () => {
            // First call during complete validation: UPLOAD_PENDING
            // Second call during rollback check: progressed to EXTRACTING
            if (callCount === 1) {
              return {
                id: resumeId,
                userId,
                storageKey,
                originalFilename: 'test.pdf',
                mimeType: 'application/pdf',
                createdAt: staleDate,
                status: 'UPLOAD_PENDING',
              };
            }
            return {
              id: resumeId,
              userId,
              storageKey,
              originalFilename: 'test.pdf',
              mimeType: 'application/pdf',
              createdAt: staleDate,
              status: 'EXTRACTING', // Progressed concurrently!
            };
          }),
          update: mockResumeUpdate,
        },
      };
      return callback(mockTx);
    });

    const { request, reply } = createMockRequestReply();
    await handleCompleteUpload(request, reply);

    expect(reply.getStatus()).toBe(503);

    // mockResumeUpdate was called once during initial transition to UPLOADED,
    // but MUST NOT be called with UPLOAD_PENDING during rollback because status is EXTRACTING
    expect(mockResumeUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'UPLOAD_PENDING',
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // Test 8: Concurrent DELETE vs cleanup does NOT produce 500 when row already deleted
  // -------------------------------------------------------------------------
  it('Scenario 8: Concurrent DELETE-versus-cleanup returns HTTP 200 without throwing 500 when row is already removed', async () => {
    // 1. Initial auth and existence check finds the resume
    mockResumeFindUnique.mockResolvedValueOnce({
      id: resumeId,
      userId,
      storageKey,
      originalFilename: 'test.pdf',
      status: 'UPLOAD_PENDING',
      sizeBytes: 1024,
    } as any);

    // 2. Storage object deletion succeeds
    mockDeleteStorageObject.mockResolvedValueOnce(undefined);

    // 3. Concurrent cleanup deletes the database row right before Step 3 runs
    mockTransaction.mockImplementation(async (callback: any) => {
      const mockTx = {
        resume: {
          findUnique: vi.fn().mockResolvedValue(null), // Row already gone!
          delete: mockResumeDelete,
        },
        auditLog: {
          create: mockAuditLogCreate,
        },
      };
      return callback(mockTx);
    });

    const { request, reply } = createMockRequestReply();
    await handleDeleteResume(request, reply);

    // Must return HTTP 200 indicating clean deletion rather than an inappropriate 500
    expect(reply.getStatus()).toBe(200);
    expect(reply.getPayload().message).toBe('Resume deleted successfully');
    expect(mockResumeDelete).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 9: Real database failure during DELETE still returns HTTP 500
  // -------------------------------------------------------------------------
  it('Scenario 9: Genuine database transaction failure during DELETE still returns HTTP 500', async () => {
    mockResumeFindUnique.mockResolvedValueOnce({
      id: resumeId,
      userId,
      storageKey,
      originalFilename: 'test.pdf',
      status: 'UPLOAD_PENDING',
      sizeBytes: 1024,
    } as any);

    mockDeleteStorageObject.mockResolvedValueOnce(undefined);

    // Genuine database failure (e.g. connection terminated)
    mockTransaction.mockRejectedValueOnce(new Error('PostgreSQL connection terminated'));

    const { request, reply } = createMockRequestReply();
    await handleDeleteResume(request, reply);

    expect(reply.getStatus()).toBe(500);
    expect(reply.getPayload().error).toBe('Internal Server Error');
  });
});
