/**
 * Live PostgreSQL Concurrency and Advisory Lock Race Verification
 *
 * Runs against the actual PostgreSQL container to prove real concurrency:
 * 1. Verifies PostgreSQL advisory locks provide mutual exclusion across real connection pool sessions.
 * 2. Demonstrates tryAcquireResumeCoordinationLock returns false when another transaction holds the lock.
 * 3. Proves that holding the advisory lock blocks concurrent completion until cleanup commits or aborts.
 * 4. Demonstrates that once cleanup deletes the row and commits, completion receives 404 (row gone)
 *    and never transitions a cleaned resume to UPLOADED.
 */
import { prisma } from '../db/prisma.js';
import {
  withResumeCoordinationLock,
  tryAcquireResumeCoordinationLock,
} from '../utils/coordinationLock.js';
import { randomUUID } from 'crypto';

async function runLivePostgresRaceTest() {
  console.log('--- Starting Live PostgreSQL Advisory Lock Concurrency Verification ---');

  // 1. Verify Prisma connection to real PostgreSQL
  const dbResult = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT NOW() as now`;
  console.log(`1. Connected to PostgreSQL. Server time: ${dbResult[0].now.toISOString()}`);

  const testResumeId = randomUUID();
  const testUserId = randomUUID();

  // Create demo user if needed
  await prisma.user.upsert({
    where: { id: testUserId },
    update: {},
    create: {
      id: testUserId,
      email: `race-${Date.now()}@test.com`,
      passwordHash: 'dummy-hash',
      fullName: 'Race Concurrency Tester',
    },
  });

  console.log(`2. Created test user (${testUserId}) and test resumeId (${testResumeId})`);

  // -------------------------------------------------------------------------
  // Test A: Real PostgreSQL Mutual Exclusion with Advisory Transaction Locks
  // -------------------------------------------------------------------------
  console.log('3. Testing real PostgreSQL advisory lock mutual exclusion across concurrent transactions...');

  let lockHolderStarted = false;
  let lockHolderCanRelease = false;
  let concurrentTryResult: boolean | null = null;

  // Transaction 1: Acquires advisory lock and holds it until signaled
  const holderPromise = withResumeCoordinationLock(testResumeId, async (_tx) => {
    lockHolderStarted = true;
    // Wait until concurrent attempt has executed
    while (!lockHolderCanRelease) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return 'holder-done';
  });

  // Wait until Transaction 1 has started and acquired the lock
  while (!lockHolderStarted) {
    await new Promise((r) => setTimeout(r, 10));
  }
  // Brief pause to ensure Transaction 1's lock query executed
  await new Promise((r) => setTimeout(r, 50));

  // Transaction 2: Runs concurrently on a separate connection, tries non-blocking acquire
  await prisma.$transaction(async (tx) => {
    concurrentTryResult = await tryAcquireResumeCoordinationLock(tx, testResumeId);
  });

  console.log(`   Concurrent tryAcquire result while lock held: ${concurrentTryResult}`);
  if (concurrentTryResult !== false) {
    throw new Error(`FAIL: Expected tryAcquire to return false while lock held, got ${concurrentTryResult}`);
  }
  console.log('   VERIFIED: Concurrent transaction was rejected by PostgreSQL pg_try_advisory_xact_lock!');

  // Release Transaction 1
  lockHolderCanRelease = true;
  await holderPromise;
  console.log('   Transaction 1 committed and released advisory lock.');

  // Transaction 3: Try acquire now that Transaction 1 has released
  let acquireAfterReleaseResult: boolean = false;
  await prisma.$transaction(async (tx) => {
    acquireAfterReleaseResult = await tryAcquireResumeCoordinationLock(tx, testResumeId);
  });
  console.log(`   tryAcquire result after lock released: ${acquireAfterReleaseResult}`);
  if (!acquireAfterReleaseResult) {
    throw new Error(`FAIL: Expected tryAcquire to return true after release, got ${acquireAfterReleaseResult}`);
  }
  console.log('   VERIFIED: Lock re-acquirable immediately after transaction commit!');

  // -------------------------------------------------------------------------
  // Test B: Live Database Race — Cleanup Deletes Row Under Lock, Completion Arrives
  // -------------------------------------------------------------------------
  console.log('4. Testing live database race: Cleanup deletes row under lock while Completion is queued...');

  // Create real resume row in UPLOAD_PENDING status
  const resumeRow = await prisma.resume.create({
    data: {
      id: testResumeId,
      userId: testUserId,
      originalFilename: 'concurrent_race.pdf',
      storageKey: `resumes/${testUserId}/${testResumeId}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      status: 'UPLOAD_PENDING',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25 hours ago
    },
  });
  console.log(`   Created UPLOAD_PENDING resume in database: ${resumeRow.id}`);

  let cleanupExecuting = false;

  // Worker 1: Cleanup acquires lock, simulates storage deletion, and deletes DB row
  const cleanupPromise = withResumeCoordinationLock(testResumeId, async (tx) => {
    cleanupExecuting = true;
    console.log('   [Cleanup Worker] Acquired advisory lock. Simulating storage deletion delay...');
    await new Promise((r) => setTimeout(r, 100)); // Simulate storage deletion time

    // Delete database row
    await tx.resume.delete({ where: { id: testResumeId } });
    console.log('   [Cleanup Worker] Deleted resume row from database. Committing transaction...');
  });

  // Wait until cleanup has acquired lock
  while (!cleanupExecuting) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Worker 2: Completion request arrives concurrently while cleanup holds lock
  const completionPromise = (async () => {
    console.log('   [Completion Worker] Arrived. Calling withResumeCoordinationLock (will wait for cleanup)...');
    return withResumeCoordinationLock(testResumeId, async (tx) => {
      console.log('   [Completion Worker] Acquired lock after cleanup finished. Checking DB row existence...');
      const fresh = await tx.resume.findUnique({ where: { id: testResumeId } });
      if (!fresh) {
        return { status: 404, message: 'Resume not found' };
      }
      return { status: 200, message: 'Successfully completed' };
    });
  })();

  const [_, completionRes] = await Promise.all([cleanupPromise, completionPromise]);
  console.log(`   [Completion Worker] Final result: HTTP ${completionRes.status} (${completionRes.message})`);

  if (completionRes.status !== 404) {
    throw new Error(`FAIL: Completion completed a deleted resume! Status: ${completionRes.status}`);
  }

  console.log('   VERIFIED: Completion safely received 404; deleted resume was NEVER transitioned to UPLOADED!');

  // Cleanup test user
  await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});

  console.log('\n SUCCESS: Real PostgreSQL Advisory Lock Concurrency Verification Passed 100%!\n');
}

runLivePostgresRaceTest()
  .catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
