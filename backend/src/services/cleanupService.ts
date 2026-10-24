import { prisma } from '../db/prisma.js';
import {
  deleteStorageObject,
  headStorageObject,
  listStorageObjects,
} from '../storage/s3.js';
import { tryAcquireResumeCoordinationLock } from '../utils/coordinationLock.js';

export interface CleanupResult {
  stalePendingCleaned: number;
  stalePendingFailed: number;
  stalePendingSkipped: number;
  orphansCleaned: number;
  orphansFailed: number;
  orphansSkipped: number;
}

export interface CleanupOptions {
  cutoffDate?: Date;
  batchSize?: number;
  maxPages?: number;
  logger?: {
    info: (obj: any, msg?: string) => void;
    warn: (obj: any, msg?: string) => void;
    error: (obj: any, msg?: string) => void;
  };
}

const defaultLogger = {
  info: (obj: any, msg?: string) => console.log(msg || '', obj),
  warn: (obj: any, msg?: string) => console.warn(msg || '', obj),
  error: (obj: any, msg?: string) => console.error(msg || '', obj),
};

/**
 * Cleans up stale UPLOAD_PENDING records that are older than 24 hours.
 *
 * Synchronization & Race Prevention:
 * 1. Synchronizes using a per-resume PostgreSQL advisory transaction lock
 *    (tryAcquireResumeCoordinationLock).
 * 2. If a concurrent upload completion holds the lock, cleanup immediately yields
 *    to protect the active upload without deleting anything.
 * 3. Inside the lock, rechecks status == 'UPLOAD_PENDING' and createdAt < cutoffDate.
 * 4. Removes associated storage object if it exists.
 * 5. If storage deletion fails, retains the database record for future retry and audits the failure.
 * 6. Atomically deletes database record inside transaction and writes an AuditLog entry.
 */
export async function cleanupStaleUploadPending(
  options?: CleanupOptions
): Promise<{ cleaned: number; failed: number; skipped: number }> {
  const cutoffDate = options?.cutoffDate ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const batchSize = options?.batchSize ?? 50;
  const logger = options?.logger ?? defaultLogger;

  let cleaned = 0;
  let failed = 0;
  let skipped = 0;

  const candidates = await prisma.resume.findMany({
    where: {
      status: 'UPLOAD_PENDING',
      createdAt: { lt: cutoffDate },
    },
    take: batchSize,
    select: {
      id: true,
      userId: true,
      storageKey: true,
      originalFilename: true,
      createdAt: true,
      status: true,
    },
  });

  for (const candidate of candidates) {
    try {
      // Execute the candidate cleanup within a dedicated transaction that acquires the coordination lock
      await prisma.$transaction(
        async (tx: any) => {
          // 1. Try to acquire the per-resume lifecycle advisory lock non-blockingly
          const lockAcquired = await tryAcquireResumeCoordinationLock(tx, candidate.id);
          if (!lockAcquired) {
            // Lock is held by an active completion request! Yield immediately to protect completion.
            skipped++;
            return;
          }

          // 2. Recheck status and creation date under the acquired coordination lock
          const fresh = await tx.resume.findUnique({
            where: { id: candidate.id },
            select: {
              id: true,
              userId: true,
              storageKey: true,
              originalFilename: true,
              createdAt: true,
              status: true,
            },
          });

          if (!fresh || fresh.status !== 'UPLOAD_PENDING' || fresh.createdAt >= cutoffDate) {
            skipped++;
            return;
          }

          // 3. Check if file exists in object storage
          let objectExists = false;
          try {
            const head = await headStorageObject(fresh.storageKey);
            objectExists = head !== null;
          } catch (headErr) {
            logger.warn(
              { err: headErr, resumeId: fresh.id, storageKey: fresh.storageKey },
              'Error checking storage object existence for stale pending candidate'
            );
          }

          // 4. Delete storage object if present
          if (objectExists) {
            try {
              await deleteStorageObject(fresh.storageKey);
            } catch (s3Err) {
              logger.error(
                { err: s3Err, resumeId: fresh.id, storageKey: fresh.storageKey },
                'Failed to delete storage object for stale UPLOAD_PENDING record; retaining DB record for retry'
              );

              // Record failure in AuditLog so failure remains observable and retryable
              await tx.auditLog.create({
                data: {
                  userId: fresh.userId,
                  action: 'RESUME_CLEANUP_STALE_PENDING_FAILED',
                  entityType: 'Resume',
                  entityId: fresh.id,
                  details: {
                    storageKey: fresh.storageKey,
                    error: s3Err instanceof Error ? s3Err.message : String(s3Err),
                    stage: 'STORAGE_DELETION',
                  },
                },
              }).catch(() => {});

              failed++;
              return; // Retain database record!
            }
          }

          // 5. Atomically delete database record and record audit log inside the same locked transaction
          await tx.auditLog.create({
            data: {
              userId: fresh.userId,
              action: 'RESUME_CLEANUP_STALE_PENDING',
              entityType: 'Resume',
              entityId: fresh.id,
              details: {
                storageKey: fresh.storageKey,
                originalFilename: fresh.originalFilename,
                createdAt: fresh.createdAt.toISOString(),
                reason: 'STALE_UPLOAD_PENDING_EXCEEDED_24H',
              },
            },
          });

          await tx.resume.delete({
            where: { id: fresh.id },
          });

          cleaned++;
          logger.info(
            { resumeId: fresh.id, storageKey: fresh.storageKey },
            'Cleaned up stale UPLOAD_PENDING resume'
          );
        },
        { timeout: 10000 }
      );
    } catch (err) {
      logger.error({ err, resumeId: candidate.id }, 'Error cleaning up stale pending resume');
      failed++;
    }
  }

  return { cleaned, failed, skipped };
}

/**
 * Cleans up orphaned storage objects under resumes/ that are older than 24 hours
 * and have no corresponding record in the database.
 *
 * Rules:
 * 1. Paginates storage objects under resumes/ prefix.
 * 2. Protects objects created within 24 hours (protects in-progress uploads).
 * 3. Checks database reference; never deletes if query fails or object is referenced.
 * 4. Rechecks database reference immediately before deletion.
 * 5. Writes AuditLog entry for deleted orphaned objects.
 */
export async function cleanupOrphanedStorageObjects(
  options?: CleanupOptions
): Promise<{ cleaned: number; failed: number; skipped: number }> {
  const cutoffDate = options?.cutoffDate ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const maxPages = options?.maxPages ?? 10;
  const logger = options?.logger ?? defaultLogger;

  let cleaned = 0;
  let failed = 0;
  let skipped = 0;

  let continuationToken: string | undefined = undefined;
  let pageCount = 0;

  do {
    pageCount++;
    let listResult;
    try {
      listResult = await listStorageObjects({
        prefix: 'resumes/',
        continuationToken,
        maxKeys: 100,
      });
    } catch (listErr) {
      logger.error({ err: listErr }, 'Storage listing failed during orphan cleanup; aborting pass safely');
      break; // Abort safely without deleting anything
    }

    const { objects, nextContinuationToken, isTruncated } = listResult;
    continuationToken = isTruncated ? nextContinuationToken : undefined;

    for (const obj of objects) {
      try {
        // Protect recently created objects (< 24 hours old) - protects in-progress uploads!
        if (!obj.lastModified || obj.lastModified >= cutoffDate) {
          skipped++;
          continue;
        }

        // Query database for references
        let dbResume;
        try {
          dbResume = await prisma.resume.findUnique({
            where: { storageKey: obj.key },
            select: { id: true, status: true },
          });
        } catch (dbErr) {
          // If database check fails, NEVER delete the object!
          logger.error(
            { err: dbErr, storageKey: obj.key },
            'Database reference check failed; preserving storage object'
          );
          failed++;
          continue;
        }

        if (dbResume !== null) {
          // Object is referenced by an active resume record
          skipped++;
          continue;
        }

        // Recheck immediately before destructive action to avoid race with completion
        const finalRecheck = await prisma.resume.findUnique({
          where: { storageKey: obj.key },
          select: { id: true },
        });

        if (finalRecheck !== null) {
          skipped++;
          continue;
        }

        // Safe deletion of verified orphan
        await deleteStorageObject(obj.key);

        await prisma.auditLog.create({
          data: {
            action: 'STORAGE_CLEANUP_ORPHAN',
            entityType: 'StorageObject',
            entityId: obj.key,
            details: {
              storageKey: obj.key,
              lastModified: obj.lastModified?.toISOString(),
              sizeBytes: obj.sizeBytes,
              reason: 'ORPHANED_STORAGE_OBJECT_EXCEEDED_24H',
            },
          },
        }).catch((auditErr) => {
          logger.warn({ err: auditErr, key: obj.key }, 'Failed to record audit log for orphan cleanup');
        });

        cleaned++;
        logger.info(
          { storageKey: obj.key, sizeBytes: obj.sizeBytes },
          'Deleted orphaned storage object'
        );
      } catch (err) {
        logger.error({ err, storageKey: obj.key }, 'Failed to delete orphaned storage object');
        failed++;
      }
    }
  } while (continuationToken && pageCount < maxPages);

  return { cleaned, failed, skipped };
}

/**
 * Master cleanup runner combining stale UPLOAD_PENDING and orphaned storage cleanup.
 */
export async function run24HourCleanup(options?: CleanupOptions): Promise<CleanupResult> {
  const logger = options?.logger ?? defaultLogger;
  logger.info({}, 'Starting 24-hour maintenance cleanup run');

  const staleResult = await cleanupStaleUploadPending(options);
  const orphanResult = await cleanupOrphanedStorageObjects(options);

  const result: CleanupResult = {
    stalePendingCleaned: staleResult.cleaned,
    stalePendingFailed: staleResult.failed,
    stalePendingSkipped: staleResult.skipped,
    orphansCleaned: orphanResult.cleaned,
    orphansFailed: orphanResult.failed,
    orphansSkipped: orphanResult.skipped,
  };

  logger.info(result, 'Completed 24-hour maintenance cleanup run');
  return result;
}
