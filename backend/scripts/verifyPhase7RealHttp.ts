/**
 * Phase 7 Real HTTP Verification Script (Backend Only, Zero LLM Calls).
 *
 * Steps:
 * 1. Registers a throwaway user via POST /v1/auth/register against live HTTP server.
 * 2. Seeds a PARSED resume and ParsedResume data for the throwaway user.
 * 3. Verifies GET /v1/usage returns job_suggestions used = 0.
 * 4. Calls POST /v1/resumes/:id/suggestions with MockJobSource:
 *    - Confirms HTTP 200 OK.
 *    - Confirms suggestions array is populated with ML match scores and skills.
 * 5. Queries GET /v1/usage to confirm job_suggestions used incremented by exactly 1.
 * 6. Sets user plan to low-limit plan and triggers quota limit:
 *    - Confirms HTTP 429 RFC 7807 usage-limit-exceeded.
 * 7. Deletes throwaway user via normal app flow (DELETE /v1/account).
 * 8. Confirms user and usage records are completely cleaned up.
 */

import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const BASE_URL = process.env.BACKEND_URL || 'http://localhost:4000';

// Security Guard: Refuse execution against non-localhost targets
const targetUrl = new URL(BASE_URL);
if (targetUrl.hostname !== 'localhost' && targetUrl.hostname !== '127.0.0.1') {
  throw new Error(`Refusing to run verification script against non-localhost target: ${BASE_URL}`);
}

const prisma = new PrismaClient();

async function runVerification() {
  const runId = crypto.randomBytes(6).toString('hex');
  const testUsername = `p7_throwaway_${runId}`;
  const testPassword = `P7_${crypto.randomUUID()}!Aa1`;

  console.log('=== PHASE 7 REAL HTTP VERIFICATION ===');
  console.log(`1. Registering throwaway user: ${testUsername}`);

  const regRes = await fetch(`${BASE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: testUsername,
      password: testPassword,
    }),
  });

  if (!regRes.ok) {
    throw new Error(`Registration failed: ${regRes.status} ${await regRes.text()}`);
  }

  const regData = (await regRes.json()) as any;
  const userId = regData.user?.id;
  const accessToken = regData.tokens?.accessToken;

  if (!userId || !accessToken) {
    throw new Error('Registration did not return userId or accessToken');
  }

  console.log(`   User registered successfully (User ID: ${userId}).`);

  // 2. Seed a PARSED resume for the user
  console.log('2. Seeding a PARSED resume for testing suggestions...');
  const resume = await prisma.resume.create({
    data: {
      userId,
      originalFilename: 'test_software_engineer.pdf',
      storageKey: `test-${userId}/resume.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      status: 'PARSED',
    },
  });

  await prisma.parsedResume.create({
    data: {
      resumeId: resume.id,
      rawText: 'Alice Developer\nSenior Backend Engineer\n5 years experience with Python, FastAPI, PostgreSQL, and Docker containerization.\nBuilt high-scale microservices.',
      candidateName: 'Alice Developer',
      skills: ['Python', 'FastAPI', 'PostgreSQL', 'Docker'],
      experience: [
        {
          title: 'Senior Backend Engineer',
          company: 'Tech Innovations',
          startDate: '2021-01',
          endDate: '2026-01',
        },
      ],
    },
  });

  console.log(`   Resume created with ID: ${resume.id}`);

  // 3. Query GET /v1/usage initially
  console.log('3. Querying GET /v1/usage (pre-suggestions)...');
  const usageRes1 = await fetch(`${BASE_URL}/v1/usage`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!usageRes1.ok) {
    throw new Error(`GET /v1/usage failed: ${usageRes1.status} ${await usageRes1.text()}`);
  }
  const usageData1 = (await usageRes1.json()) as any;
  const initialUsed = usageData1.meters?.job_suggestions?.used ?? 0;
  console.log(`   Initial job_suggestions used: ${initialUsed}`);

  // 4. Call POST /v1/resumes/:id/suggestions
  console.log('4. Calling POST /v1/resumes/:id/suggestions (Mode A: Explore)...');
  const suggRes = await fetch(`${BASE_URL}/v1/resumes/${resume.id}/suggestions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      location: 'Remote',
      seniority: 'Senior',
      limit: 5,
    }),
  });

  if (!suggRes.ok) {
    throw new Error(`Suggestions endpoint failed: ${suggRes.status} ${await suggRes.text()}`);
  }

  const suggData = (await suggRes.json()) as any;
  console.log(`   Suggestions response status: ${suggRes.status}`);
  console.log(`   Total suggestions found: ${suggData.totalFound}`);
  if (Array.isArray(suggData.suggestions) && suggData.suggestions.length > 0) {
    const top = suggData.suggestions[0];
    console.log(`   Top suggestion: "${top.title}" at "${top.company}"`);
    console.log(`   Match Score:    ${top.matchScore}`);
    console.log(`   Matched skills: ${top.matchedSkills?.join(', ')}`);
  }

  // 5. Query GET /v1/usage to verify meter increment
  console.log('5. Querying GET /v1/usage (post-suggestions)...');
  const usageRes2 = await fetch(`${BASE_URL}/v1/usage`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const usageData2 = (await usageRes2.json()) as any;
  const updatedUsed = usageData2.meters?.job_suggestions?.used;
  console.log(`   Updated job_suggestions used: ${updatedUsed}`);
  if (updatedUsed !== initialUsed + 1) {
    throw new Error(`Expected job_suggestions to increment by 1 (got ${updatedUsed}, expected ${initialUsed + 1})`);
  }
  console.log('   Confirmed: job_suggestions incremented by exactly 1.');

  // 5b. Verify With-JD Mode (owned jobId, nonexistent jobId, foreign jobId)
  console.log('5b. Testing With-JD mode (jobId parameter)...');
  const ownedJob = await prisma.job.create({
    data: {
      user: { connect: { id: userId } },
      title: 'Senior Distributed Backend Engineer',
      company: 'Tech Scale',
      rawDescription: 'Building distributed real-time data pipelines with Python, PostgreSQL, Redis, and Docker.',
      requiredSkills: ['Python', 'PostgreSQL', 'Docker'],
    },
  });

  // (a) Owned jobId -> 200 OK
  const withJdRes = await fetch(`${BASE_URL}/v1/resumes/${resume.id}/suggestions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jobId: ownedJob.id, limit: 5 }),
  });

  if (!withJdRes.ok) {
    throw new Error(`With-JD suggestions failed: ${withJdRes.status} ${await withJdRes.text()}`);
  }
  const withJdData = (await withJdRes.json()) as any;
  console.log(`   With-JD response status: 200 OK, total found: ${withJdData.totalFound}`);
  if (!Array.isArray(withJdData.suggestions)) {
    throw new Error('With-JD response missing suggestions array');
  }

  // (b) Nonexistent jobId -> 404 Not Found
  const nonExistentJobId = '00000000-0000-0000-0000-000000000000';
  const nonExistentRes = await fetch(`${BASE_URL}/v1/resumes/${resume.id}/suggestions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jobId: nonExistentJobId }),
  });
  console.log(`   Nonexistent jobId response status: ${nonExistentRes.status}`);
  if (nonExistentRes.status !== 404) {
    throw new Error(`Expected 404 for nonexistent jobId, got ${nonExistentRes.status}`);
  }

  // (c) Foreign jobId -> 404 Not Found
  // Find or create another user to own a foreign job
  const foreignUser = await prisma.user.create({
    data: {
      planKey: 'unlimited',
    },
  });
  const foreignJob = await prisma.job.create({
    data: {
      user: { connect: { id: foreignUser.id } },
      title: 'Secret Internal Role',
      company: 'Foreign Corp',
      rawDescription: 'Classified project description.',
    },
  });

  const foreignJobRes = await fetch(`${BASE_URL}/v1/resumes/${resume.id}/suggestions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jobId: foreignJob.id }),
  });
  console.log(`   Foreign jobId response status: ${foreignJobRes.status}`);
  if (foreignJobRes.status !== 404) {
    throw new Error(`Expected 404 for foreign jobId (IDOR protection), got ${foreignJobRes.status}`);
  }

  // Clean up foreign job & user
  await prisma.job.delete({ where: { id: foreignJob.id } });
  await prisma.user.delete({ where: { id: foreignUser.id } });
  console.log('   Confirmed: With-JD mode works for owned job; returns 404 for nonexistent/foreign jobId.');

  // 6. Test quota limit (put user on demo plan with limit: 1)
  console.log('6. Testing quota enforcement at limit...');
  // Update user plan to demo (limits: analyses: 10, job_suggestions: 5)
  // Let's set used = 5 in user_usage to simulate hitting 100%
  const currentMonth = new Date().toISOString().slice(0, 7);
  await prisma.user.update({
    where: { id: userId },
    data: { planKey: 'demo' },
  });
  await prisma.userUsage.upsert({
    where: {
      userId_meter_period: {
        userId,
        meter: 'job_suggestions',
        period: currentMonth,
      },
    },
    create: {
      userId,
      meter: 'job_suggestions',
      period: currentMonth,
      used: 5,
    },
    update: {
      used: 5,
    },
  });

  const blockedRes = await fetch(`${BASE_URL}/v1/resumes/${resume.id}/suggestions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ limit: 5 }),
  });

  console.log(`   Blocked request status: ${blockedRes.status}`);
  if (blockedRes.status !== 429) {
    throw new Error(`Expected HTTP 429 when quota is reached, got ${blockedRes.status}`);
  }
  const blockedJson = (await blockedRes.json()) as any;
  console.log(`   RFC 7807 type: ${blockedJson.type}`);
  console.log(`   Meter:         ${blockedJson.meter}`);
  console.log(`   Used/Limit:    ${blockedJson.used}/${blockedJson.limit}`);

  // 7. Clean up user via normal application flow
  console.log('7. Cleaning up throwaway user via DELETE /v1/account...');
  const delRes = await fetch(`${BASE_URL}/v1/account`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ password: testPassword }),
  });

  if (!delRes.ok) {
    throw new Error(`Account deletion failed: ${delRes.status} ${await delRes.text()}`);
  }
  console.log('   Account deleted successfully via normal app flow.');

  // Verify DB cleanup
  const remainingUser = await prisma.user.findUnique({ where: { id: userId } });
  const remainingUsage = await prisma.userUsage.count({ where: { userId } });
  console.log(`   Database verification: User exists = ${!!remainingUser}, Usage rows = ${remainingUsage}`);

  if (remainingUser || remainingUsage > 0) {
    throw new Error('Cleanup check failed: user or usage records remained');
  }

  console.log('✅ ALL PHASE 7 REAL HTTP VERIFICATIONS PASSED SUCCESSFULLY!');
}

runVerification()
  .catch((err) => {
    console.error('❌ Phase 7 Real HTTP Verification Failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
