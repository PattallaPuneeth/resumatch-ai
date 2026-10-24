/**
 * Comprehensive tests for 24-Hour Maintenance Cleanup Worker (§4.4)
 *
 * Covers:
 * 1. Stale UPLOAD_PENDING records (> 24h) are cleaned up.
 * 2. Recent UPLOAD_PENDING records (< 24h) are preserved.
 * 3. Records progressed beyond UPLOAD_PENDING are preserved.
 * 4. Storage deletion failure preserves DB record and writes failed audit log.
 * 5. Orphaned storage objects (> 24h) are deleted when unreferenced.
 * 6. Recent storage objects (< 24h) and DB-referenced objects are preserved.
 * 7. Database or storage listing failures never trigger unsafe deletion.
 * 8. Pagination across multiple pages works correctly.
 * 9. Repeated runs are safe and idempotent.
 * 10. Concurrent upload completion / record changes prevent active resume deletion.
 * 11. Scheduled job registration and BullMQ wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module Mocks
// ---------------------------------------------------------------------------
vi.mock('../db/prisma.js', () => ({
  prisma: {
    resume: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../storage/s3.js', () => ({
  deleteStorageObject: vi.fn(),
  headStorageObject: vi.fn(),
  listStorageObjects: vi.fn(),
}));

vi.mock('../queues/bullmq.js', () => ({
  redisConnectionOptions: { host: 'localhost', port: 6379 },
}));

const {
  mockQueueAdd,
  mockQueueGetRepeatableJobs,
  mockQueueRemoveRepeatableByKey,
  mockQueueClose,
  mockWorkerClose,
} = vi.hoisted(() => ({
  mockQueueAdd: vi.fn().mockResolvedValue({ id: 'job-1' }),
  mockQueueGetRepeatableJobs: vi.fn().mockResolvedValue([]),
  mockQueueRemoveRepeatableByKey: vi.fn().mockResolvedValue(true),
  mockQueueClose: vi.fn().mockResolvedValue(undefined),
  mockWorkerClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    getRepeatableJobs: mockQueueGetRepeatableJobs,
    removeRepeatableByKey: mockQueueRemoveRepeatableByKey,
    close: mockQueueClose,
  })),
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: mockWorkerClose,
  })),
}));

// ---------------------------------------------------------------------------
// Imports & References
// ---------------------------------------------------------------------------
import { prisma } from '../db/prisma.js';
import {
  deleteStorageObject,
  headStorageObject,
  listStorageObjects,
} from '../storage/s3.js';
import {
  cleanupStaleUploadPending,
  cleanupOrphanedStorageObjects,
  run24HourCleanup,
} from '../services/cleanupService.js';
import {
  registerScheduledCleanupJob,
  startCleanupWorker,
  stopCleanupWorker,
  processCleanupJob,
  CLEANUP_JOB_NAME,
} from '../queues/cleanupQueue.js';

const mockResumeFindMany = vi.mocked(prisma.resume.findMany);
const mockResumeFindUnique = vi.mocked(prisma.resume.findUnique);
const mockResumeDelete = vi.mocked(prisma.resume.delete);
const mockAuditLogCreate = vi.mocked(prisma.auditLog.create);
const mockTransaction = vi.mocked(prisma.$transaction);

const mockDeleteStorageObject = vi.mocked(deleteStorageObject);
const mockHeadStorageObject = vi.mocked(headStorageObject);
const mockListStorageObjects = vi.mocked(listStorageObjects);

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('24-Hour Maintenance Cleanup Worker (§4.4)', () => {
  const now = new Date('2026-10-24T12:00:00.000Z');
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 2026-10-23T12:00:00.000Z
  const staleDate = new Date(cutoff24h.getTime() - 60 * 1000); // 24h + 1min old
  const recentDate = new Date(cutoff24h.getTime() + 60 * 1000); // 23h59m old

  beforeEach(() => {
    vi.clearAllMocks();

    mockAuditLogCreate.mockResolvedValue({ id: 'audit-1' } as any);
    mockDeleteStorageObject.mockResolvedValue(undefined);
    mockHeadStorageObject.mockResolvedValue(null);
    mockResumeDelete.mockResolvedValue({ id: 'deleted-1' } as any);

    // Default transaction executes callback immediately with tx mock
    mockTransaction.mockImplementation(async (callback: any) => {
      const tx = {
        resume: {
          findUnique: mockResumeFindUnique,
          delete: mockResumeDelete,
        },
        auditLog: {
          create: mockAuditLogCreate,
        },
      };
      return callback(tx);
    });
  });

  // =========================================================================
  // Case A: Stale UPLOAD_PENDING Records
  // =========================================================================
  describe('A. Stale UPLOAD_PENDING cleanup', () => {
    it('1. cleans up stale UPLOAD_PENDING records older than 24 hours', async () => {
      const staleResume = {
        id: 'stale-res-1',
        userId: 'user-1',
        storageKey: 'resumes/user-1/stale-res-1.pdf',
        originalFilename: 'old_resume.pdf',
        createdAt: staleDate,
        status: 'UPLOAD_PENDING',
      };

      mockResumeFindMany.mockResolvedValueOnce([staleResume as any]);
      mockResumeFindUnique.mockResolvedValue(staleResume as any);
      mockHeadStorageObject.mockResolvedValueOnce({ contentLength: 5000 });
      mockDeleteStorageObject.mockResolvedValueOnce(undefined);
      mockResumeDelete.mockResolvedValueOnce(staleResume as any);
      mockAuditLogCreate.mockResolvedValueOnce({ id: 'audit-1' } as any);

      const result = await cleanupStaleUploadPending({
        cutoffDate: cutoff24h,
        logger: silentLogger,
      });

      expect(result.cleaned).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);

      // Verifies storage object is deleted
      expect(mockDeleteStorageObject).toHaveBeenCalledWith('resumes/user-1/stale-res-1.pdf');
      // Verifies DB record is deleted
      expect(mockResumeDelete).toHaveBeenCalledWith({ where: { id: 'stale-res-1' } });
      // Verifies audit log is created
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            action: 'RESUME_CLEANUP_STALE_PENDING',
            entityId: 'stale-res-1',
          }),
        })
      );
    });

    it('2. preserves recent UPLOAD_PENDING records created within 24 hours', async () => {
      const recentResume = {
        id: 'recent-res-1',
        userId: 'user-1',
        storageKey: 'resumes/user-1/recent-res-1.pdf',
        originalFilename: 'new_resume.pdf',
        createdAt: recentDate,
        status: 'UPLOAD_PENDING',
      };

      // Candidate returned by initial query, but fresh recheck reveals recent timestamp
      mockResumeFindMany.mockResolvedValueOnce([recentResume as any]);
      mockResumeFindUnique.mockResolvedValueOnce(recentResume as any);

      const result = await cleanupStaleUploadPending({
        cutoffDate: cutoff24h,
        logger: silentLogger,
      });

      expect(result.cleaned).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockDeleteStorageObject).not.toHaveBeenCalled();
      expect(mockResumeDelete).not.toHaveBeenCalled();
    });

    it('3. preserves records that have progressed beyond UPLOAD_PENDING', async () => {
      const progressedResume = {
        id: 'prog-res-1',
        userId: 'user-1',
        storageKey: 'resumes/user-1/prog-res-1.pdf',
        originalFilename: 'active_resume.pdf',
        createdAt: staleDate,
        status: 'UPLOADED', // User completed upload!
      };

      mockResumeFindMany.mockResolvedValueOnce([progressedResume as any]);
      mockResumeFindUnique.mockResolvedValueOnce(progressedResume as any);

      const result = await cleanupStaleUploadPending({
        cutoffDate: cutoff24h,
        logger: silentLogger,
      });

      expect(result.cleaned).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockDeleteStorageObject).not.toHaveBeenCalled();
      expect(mockResumeDelete).not.toHaveBeenCalled();
    });

    it('4. retains database record for retry if storage deletion fails', async () => {
      const staleResume = {
        id: 'stale-res-s3-fail',
        userId: 'user-1',
        storageKey: 'resumes/user-1/stale-res-s3-fail.pdf',
        originalFilename: 's3_fail.pdf',
        createdAt: staleDate,
        status: 'UPLOAD_PENDING',
      };

      mockResumeFindMany.mockResolvedValueOnce([staleResume as any]);
      mockResumeFindUnique.mockResolvedValueOnce(staleResume as any);
      mockHeadStorageObject.mockResolvedValueOnce({ contentLength: 5000 });
      mockDeleteStorageObject.mockRejectedValueOnce(new Error('S3 503 SlowDown'));

      const result = await cleanupStaleUploadPending({
        cutoffDate: cutoff24h,
        logger: silentLogger,
      });

      expect(result.cleaned).toBe(0);
      expect(result.failed).toBe(1);

      // Crucial: DB record MUST NOT be deleted so reference is preserved for next retry
      expect(mockResumeDelete).not.toHaveBeenCalled();

      // Observable audit failure
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'RESUME_CLEANUP_STALE_PENDING_FAILED',
            entityId: 'stale-res-s3-fail',
          }),
        })
      );
    });
  });

  // =========================================================================
  // Case B: Orphaned Storage Objects
  // =========================================================================
  describe('B. Orphaned storage objects cleanup', () => {
    it('5. deletes orphaned storage objects older than 24 hours with no DB reference', async () => {
      mockListStorageObjects.mockResolvedValueOnce({
        objects: [
          {
            key: 'resumes/orphan-uuid/file.pdf',
            lastModified: staleDate,
            sizeBytes: 2048,
          },
        ],
        isTruncated: false,
      });

      // DB check returns null (no database reference exists)
      mockResumeFindUnique.mockResolvedValue(null);
      mockDeleteStorageObject.mockResolvedValueOnce(undefined);
      mockAuditLogCreate.mockResolvedValueOnce({ id: 'audit-orphan-1' } as any);

      const result = await cleanupOrphanedStorageObjects({
        cutoffDate: cutoff24h,
        logger: silentLogger,
      });

      expect(result.cleaned).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);

      expect(mockDeleteStorageObject).toHaveBeenCalledWith('resumes/orphan-uuid/file.pdf');
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'STORAGE_CLEANUP_ORPHAN',
            entityId: 'resumes/orphan-uuid/file.pdf',
          }),
        })
      );
    });

    it('6. preserves recent objects (< 24h) and objects referenced by database', async () => {
      mockListStorageObjects.mockResolvedValueOnce({
        objects: [
          {
            key: 'resumes/active-user/active.pdf',
            lastModified: staleDate,
            sizeBytes: 1024,
          },
          {
            key: 'resumes/in-progress/upload.pdf',
            lastModified: recentDate, // In-progress upload (< 24h)!
            sizeBytes: 1024,
          },
        ],
        isTruncated: false,
      });

      // Active object has a DB record
      mockResumeFindUnique.mockResolvedValueOnce({ id: 'active-1', status: 'PARSED' } as any);

      const result = await cleanupOrphanedStorageObjects({
        cutoffDate: cutoff24h,
        logger: silentLogger,
      });

      expect(result.cleaned).toBe(0);
      expect(result.skipped).toBe(2);
      expect(mockDeleteStorageObject).not.toHaveBeenCalled();
    });

    it('7. preserves objects when database reference query fails', async () => {
      mockListStorageObjects.mockResolvedValueOnce({
        objects: [
          {
            key: 'resumes/user-x/doc.pdf',
            lastModified: staleDate,
            sizeBytes: 2048,
          },
        ],
        isTruncated: false,
      });

      // DB query throws transient error
      mockResumeFindUnique.mockRejectedValueOnce(new Error('PostgreSQL connection drop'));

      const result = await cleanupOrphanedStorageObjects({
        cutoffDate: cutoff24h,
        logger: silentLogger,
      });

      expect(result.cleaned).toBe(0);
      expect(result.failed).toBe(1);
      // NEVER delete when reference check cannot be established confidently!
      expect(mockDeleteStorageObject).not.toHaveBeenCalled();
    });

    it('8. handles storage listing pagination across multiple pages', async () => {
      // Page 1
      mockListStorageObjects.mockResolvedValueOnce({
        objects: [
          {
            key: 'resumes/p1/orphan1.pdf',
            lastModified: staleDate,
            sizeBytes: 100,
          },
        ],
        nextContinuationToken: 'token-page-2',
        isTruncated: true,
      });

      // Page 2
      mockListStorageObjects.mockResolvedValueOnce({
        objects: [
          {
            key: 'resumes/p2/orphan2.pdf',
            lastModified: staleDate,
            sizeBytes: 200,
          },
        ],
        nextContinuationToken: undefined,
        isTruncated: false,
      });

      mockResumeFindUnique.mockResolvedValue(null);
      mockDeleteStorageObject.mockResolvedValue(undefined);

      const result = await cleanupOrphanedStorageObjects({
        cutoffDate: cutoff24h,
        maxPages: 5,
        logger: silentLogger,
      });

      expect(result.cleaned).toBe(2);
      expect(mockListStorageObjects).toHaveBeenCalledTimes(2);
      expect(mockListStorageObjects).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ continuationToken: 'token-page-2' })
      );
    });

    it('9. repeated cleanup runs are idempotent and safe', async () => {
      mockListStorageObjects.mockResolvedValue({
        objects: [],
        isTruncated: false,
      });
      mockResumeFindMany.mockResolvedValue([]);

      const run1 = await run24HourCleanup({ cutoffDate: cutoff24h, logger: silentLogger });
      const run2 = await run24HourCleanup({ cutoffDate: cutoff24h, logger: silentLogger });

      expect(run1.stalePendingCleaned).toBe(0);
      expect(run2.stalePendingCleaned).toBe(0);
      expect(mockDeleteStorageObject).not.toHaveBeenCalled();
    });

    it('10. recheck guard prevents deletion if upload completes concurrently', async () => {
      mockListStorageObjects.mockResolvedValueOnce({
        objects: [
          {
            key: 'resumes/concurrent/resume.pdf',
            lastModified: staleDate,
            sizeBytes: 1024,
          },
        ],
        isTruncated: false,
      });

      // Initial check returns null (looks orphaned)
      mockResumeFindUnique.mockResolvedValueOnce(null);
      // Final recheck right before delete returns newly committed resume!
      mockResumeFindUnique.mockResolvedValueOnce({ id: 'concurrent-res-id' } as any);

      const result = await cleanupOrphanedStorageObjects({
        cutoffDate: cutoff24h,
        logger: silentLogger,
      });

      expect(result.cleaned).toBe(0);
      expect(result.skipped).toBe(1);
      // Recheck guard prevented deletion of active file!
      expect(mockDeleteStorageObject).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Case C: Scheduling & BullMQ Registration
  // =========================================================================
  describe('C. Scheduling and BullMQ Worker Wiring', () => {
    it('11. registers repeatable cleanup job idempotently and wires worker', async () => {
      // Existing repeatable job simulation
      mockQueueGetRepeatableJobs.mockResolvedValueOnce([
        { name: CLEANUP_JOB_NAME, key: 'old-repeatable-key' } as any,
      ]);

      await registerScheduledCleanupJob('0 * * * *');

      // Removes previous repeatable job to prevent duplicates
      expect(mockQueueRemoveRepeatableByKey).toHaveBeenCalledWith('old-repeatable-key');

      // Adds repeatable job
      expect(mockQueueAdd).toHaveBeenCalledWith(
        CLEANUP_JOB_NAME,
        expect.objectContaining({ trigger: 'SCHEDULED' }),
        expect.objectContaining({
          repeat: { pattern: '0 * * * *' },
          jobId: 'scheduled-24h-cleanup',
        })
      );

      // Start worker
      const worker = startCleanupWorker();
      expect(worker).toBeDefined();

      // Process job handler
      mockResumeFindMany.mockResolvedValue([]);
      mockListStorageObjects.mockResolvedValue({ objects: [], isTruncated: false });
      const jobResult = await processCleanupJob({} as any);
      expect(jobResult).toBeDefined();
      expect(jobResult.stalePendingCleaned).toBe(0);

      // Stop worker
      await stopCleanupWorker();
      expect(mockWorkerClose).toHaveBeenCalled();
      expect(mockQueueClose).toHaveBeenCalled();
    });
  });
});
