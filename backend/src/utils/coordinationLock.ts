import { prisma } from '../db/prisma.js';

export const RESUME_LOCK_NAMESPACE = 'resume-lifecycle';

/**
 * Executes a function within a per-resume PostgreSQL advisory transaction lock.
 * Ensures mutual exclusion between upload completion and stale cleanup for the same resume.
 *
 * If running in a test mock environment where $transaction is not provided,
 * it safely delegates to the callback with the mock prisma instance.
 */
export async function withResumeCoordinationLock<T>(
  resumeId: string,
  fn: (tx: any) => Promise<T>
): Promise<T> {
  const lockKey = `${RESUME_LOCK_NAMESPACE}:${resumeId}`;

  if (typeof prisma.$transaction === 'function') {
    return prisma.$transaction(
      async (tx: any) => {
        if (typeof tx.$executeRaw === 'function') {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        }
        return fn(tx);
      },
      { timeout: 10000 }
    );
  }

  return fn(prisma);
}

/**
 * Attempts to acquire a per-resume advisory lock non-blockingly.
 * Returns true if the lock was acquired, false if another transaction holds it.
 */
export async function tryAcquireResumeCoordinationLock(
  tx: any,
  resumeId: string
): Promise<boolean> {
  const lockKey = `${RESUME_LOCK_NAMESPACE}:${resumeId}`;

  if (typeof tx.$queryRaw === 'function') {
    const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) as acquired
    `;
    return Boolean(rows[0]?.acquired ?? true);
  }

  return true;
}
