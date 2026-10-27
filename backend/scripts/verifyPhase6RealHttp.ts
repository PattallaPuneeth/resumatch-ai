/**
 * Phase 6 Real HTTP Verification Script (Backend Only, Zero LLM Calls).
 *
 * Steps:
 * 1. Registers a throwaway user via POST /v1/auth/register against live HTTP server.
 * 2. Runs setPlan logic from host to update user to "demo" plan.
 * 3. Verifies GET /v1/usage returns plan "demo" and meter limits.
 * 4. Normal upload flow:
 *    a) Requests upload URL for 4,000,000 byte PDF.
 *    b) Uploads payload to presigned URL (MinIO).
 *    c) Completes upload via POST /v1/resumes/:id/complete (transitions to UPLOADED).
 *    d) Verifies /v1/usage shows 4,000,000 bytes used.
 *    e) Requests upload URL for 2,000,000 byte PDF (exceeds 5,242,880 limit).
 *    f) Confirms HTTP 429 RFC 7807 type usage-limit-exceeded block.
 * 5. Deletes throwaway user via DELETE /v1/account.
 * 6. Confirms user and usage records are completely removed.
 *
 * Rule: NEVER logs passwords, tokens, or DATABASE_URL.
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
  const testUsername = `p6_throwaway_${runId}`;
  const testPassword = `P6_${crypto.randomUUID()}!Aa1`;

  console.log('=== PHASE 6 REAL HTTP VERIFICATION ===');
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

  // 2. Run setPlan to put throwaway user on "demo"
  console.log('2. Running setPlan to assign "demo" plan...');
  const plan = await prisma.plan.findUnique({ where: { key: 'demo' } });
  if (!plan) {
    throw new Error('Demo plan not found in database');
  }
  await prisma.user.update({
    where: { id: userId },
    data: { planKey: 'demo' },
  });
  console.log(`   User plan set to "demo" (limits: ${JSON.stringify(plan.limits)}).`);

  // 3. Verify GET /v1/usage output
  console.log('3. Querying GET /v1/usage...');
  const usageRes = await fetch(`${BASE_URL}/v1/usage`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!usageRes.ok) {
    throw new Error(`GET /v1/usage failed: ${usageRes.status} ${await usageRes.text()}`);
  }

  const usageData = (await usageRes.json()) as any;
  console.log(`   Plan: ${usageData.plan} (${usageData.planName})`);
  console.log(`   Analyses limit: ${usageData.meters.analyses.limit}, used: ${usageData.meters.analyses.used}`);
  console.log(`   Storage limit:  ${usageData.meters.resume_storage_bytes.limit}, used: ${usageData.meters.resume_storage_bytes.used}`);

  if (usageData.plan !== 'demo') {
    throw new Error(`Expected plan "demo", got "${usageData.plan}"`);
  }
  if (usageData.meters.resume_storage_bytes.limit !== 5242880) {
    throw new Error(`Expected storage limit 5242880, got ${usageData.meters.resume_storage_bytes.limit}`);
  }
  if (usageData.meters.analyses.limit !== 10) {
    throw new Error(`Expected analyses limit 10, got ${usageData.meters.analyses.limit}`);
  }

  // 4. Normal upload flow
  console.log('4. Normal upload flow verification:');
  const uploadSize = 4_000_000;
  console.log(`   a) Requesting upload URL for ${uploadSize} bytes...`);
  const uploadUrlRes = await fetch(`${BASE_URL}/v1/resumes/upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      filename: 'first_resume.pdf',
      mimeType: 'application/pdf',
      sizeBytes: uploadSize,
    }),
  });

  if (!uploadUrlRes.ok) {
    throw new Error(`Upload URL request failed: ${uploadUrlRes.status} ${await uploadUrlRes.text()}`);
  }

  const uploadUrlData = (await uploadUrlRes.json()) as any;
  const resumeId = uploadUrlData.resumeId;
  const presignedUrl = uploadUrlData.uploadUrl;
  console.log(`   b) Upload URL received. Uploading ${uploadSize} bytes to storage...`);

  // Construct valid PDF buffer with %PDF- header of exact size
  const pdfHeader = Buffer.from('%PDF-1.4\n');
  const pdfBody = Buffer.alloc(uploadSize - pdfHeader.length, 'A');
  const fileBuffer = Buffer.concat([pdfHeader, pdfBody]);

  const s3PutRes = await fetch(presignedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/pdf',
    },
    body: fileBuffer,
  });

  if (!s3PutRes.ok) {
    throw new Error(`S3 PUT failed: ${s3PutRes.status} ${await s3PutRes.text()}`);
  }

  console.log('   c) S3 upload complete. Calling POST /v1/resumes/:id/complete...');
  const completeRes = await fetch(`${BASE_URL}/v1/resumes/${resumeId}/complete`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!completeRes.ok) {
    throw new Error(`Complete upload failed: ${completeRes.status} ${await completeRes.text()}`);
  }

  const completeData = (await completeRes.json()) as any;
  console.log(`   d) Complete status: ${completeRes.status} (status: ${completeData.status})`);

  // Verify storage gauge now shows 4,000,000 bytes
  const updatedUsageRes = await fetch(`${BASE_URL}/v1/usage`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const updatedUsage = (await updatedUsageRes.json()) as any;
  console.log(`   e) Updated storage used: ${updatedUsage.meters.resume_storage_bytes.used}/${updatedUsage.meters.resume_storage_bytes.limit} bytes (${updatedUsage.meters.resume_storage_bytes.percent}%)`);

  if (updatedUsage.meters.resume_storage_bytes.used !== uploadSize) {
    throw new Error(`Expected storage used ${uploadSize}, got ${updatedUsage.meters.resume_storage_bytes.used}`);
  }

  // Attempt to upload a second file that exceeds remaining quota
  const exceedingSize = 2_000_000;
  console.log(`   f) Attempting upload-url for second file of ${exceedingSize} bytes (4MB + 2MB > 5MB limit)...`);
  const blockedRes = await fetch(`${BASE_URL}/v1/resumes/upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      filename: 'second_resume.pdf',
      mimeType: 'application/pdf',
      sizeBytes: exceedingSize,
    }),
  });

  console.log(`   g) Second upload-url response status: ${blockedRes.status}`);
  if (blockedRes.status !== 429) {
    throw new Error(`Expected HTTP 429, got ${blockedRes.status}: ${await blockedRes.text()}`);
  }

  const blockedBody = (await blockedRes.json()) as any;
  console.log(`      RFC 7807 type:  ${blockedBody.type}`);
  console.log(`      Meter:          ${blockedBody.meter}`);
  console.log(`      Used/Limit:     ${blockedBody.used}/${blockedBody.limit}`);
  console.log(`      Detail:         ${blockedBody.detail}`);

  if (blockedBody.type !== 'https://api.resumatch.ai/errors/usage-limit-exceeded') {
    throw new Error(`Expected type usage-limit-exceeded, got ${blockedBody.type}`);
  }
  if (blockedBody.meter !== 'resume_storage_bytes') {
    throw new Error(`Expected meter resume_storage_bytes, got ${blockedBody.meter}`);
  }

  // 5. Delete throwaway user via DELETE /v1/account
  console.log('5. Deleting throwaway user via DELETE /v1/account...');
  const delRes = await fetch(`${BASE_URL}/v1/account`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      password: testPassword,
    }),
  });

  if (!delRes.ok) {
    throw new Error(`Account deletion failed: ${delRes.status} ${await delRes.text()}`);
  }

  const delData = (await delRes.json()) as any;
  console.log(`   Account deletion response: ${delRes.status} (${delData.message})`);

  // Verify DB clean
  const checkUser = await prisma.user.findUnique({ where: { id: userId } });
  const checkUsage = await prisma.userUsage.count({ where: { userId } });

  console.log(`   Database verification: User exists = ${checkUser !== null}, Usage rows = ${checkUsage}`);
  if (checkUser !== null || checkUsage !== 0) {
    throw new Error('Cleanup verification failed: User or usage records still exist in database');
  }

  console.log('✅ ALL PHASE 6 REAL HTTP VERIFICATIONS PASSED SUCCESSFULLY!');
}

runVerification()
  .catch((err) => {
    console.error('❌ Verification failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
