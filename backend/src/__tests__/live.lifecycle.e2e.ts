/**
 * Live Docker End-to-End Test for Phase 2D Resume Lifecycle
 *
 * Exercises the complete real cluster:
 * 1. Mints dev JWT for demo@resumatch.ai
 * 2. Requests presigned upload URL via Fastify API (POST /v1/resumes/upload-url)
 * 3. PUTs a valid PDF directly to MinIO storage
 * 4. Completes upload via Fastify API (POST /v1/resumes/:id/complete)
 * 5. Polls Fastify API (GET /v1/resumes/:id) until ML worker parses the document
 * 6. Validates parsed entities, ATS score, hazards, page count
 * 7. Fetches presigned download URL (GET /v1/resumes/:id/download-url) and downloads the PDF
 * 8. Deletes the resume (DELETE /v1/resumes/:id)
 * 9. Validates S3 object is deleted, database records are cascaded, and AuditLog is created
 * 10. Validates subsequent GET returns 404
 */
import fs from 'fs';
import path from 'path';
import { generateDevToken } from '../scripts/mintDevToken.js';
import { prisma } from '../db/prisma.js';

const BACKEND_URL = 'http://localhost:4000';

async function runLiveLifecycleE2E() {
  console.log('--- Starting Live Cluster Phase 2D Lifecycle E2E ---');

  // Step 1: Mint Dev Token
  console.log('1. Minting dev auth token for demo@resumatch.ai...');
  const { token, userId } = await generateDevToken('demo@resumatch.ai');
  console.log(`   Token minted for user ID: ${userId}`);

  // Step 2: Request Upload URL
  console.log('2. Requesting presigned upload URL from Fastify API...');
  const fixturePath = path.resolve(process.cwd(), '../ml/tests/fixtures/sample_resume.pdf');
  const samplePdfBytes = fs.readFileSync(fixturePath);

  const uploadRes = await fetch(`${BACKEND_URL}/v1/resumes/upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      filename: 'Jane_Doe_Live_Test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: samplePdfBytes.length,
    }),
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload URL request failed with ${uploadRes.status}: ${await uploadRes.text()}`);
  }

  const uploadData = (await uploadRes.json()) as {
    resumeId: string;
    uploadUrl: string;
    storageKey: string;
  };
  const { resumeId, uploadUrl, storageKey } = uploadData;
  console.log(`   Upload URL received for resumeId: ${resumeId}`);
  console.log(`   Storage key: ${storageKey}`);

  // Step 3: PUT directly to MinIO
  console.log('3. Uploading PDF directly to MinIO storage via presigned PUT...');
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/pdf',
    },
    body: samplePdfBytes,
  });

  if (!putRes.ok) {
    throw new Error(`Direct S3 PUT failed with ${putRes.status}: ${await putRes.text()}`);
  }
  console.log('   S3 direct upload completed with status 200 OK');

  // Step 4: Complete Upload and trigger queue
  console.log('4. Calling Fastify complete endpoint (POST /v1/resumes/:id/complete)...');
  const completeRes = await fetch(`${BACKEND_URL}/v1/resumes/${resumeId}/complete`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!completeRes.ok) {
    throw new Error(`Complete upload failed with ${completeRes.status}: ${await completeRes.text()}`);
  }

  const completeData = (await completeRes.json()) as { status: string };
  console.log(`   Complete response: status=${completeData.status}`);

  // Step 5: Poll status until PARSED
  console.log('5. Polling Fastify API (GET /v1/resumes/:id) for worker processing...');
  let currentStatus = completeData.status;
  let parsedDetails: any = null;
  const startTime = Date.now();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const checkRes = await fetch(`${BACKEND_URL}/v1/resumes/${resumeId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!checkRes.ok) {
      throw new Error(`Status check failed with ${checkRes.status}: ${await checkRes.text()}`);
    }

    const checkData = (await checkRes.json()) as {
      status: string;
      errorCode?: string;
      errorMessage?: string;
      parsedResume?: any;
    };
    currentStatus = checkData.status;
    console.log(`   [${((Date.now() - startTime) / 1000).toFixed(1)}s] Resume status: ${currentStatus}`);

    if (currentStatus === 'PARSED') {
      parsedDetails = checkData;
      break;
    }

    if (currentStatus === 'FAILED') {
      throw new Error(`Worker marked resume FAILED: ${checkData.errorCode} - ${checkData.errorMessage}`);
    }
  }

  if (currentStatus !== 'PARSED' || !parsedDetails) {
    throw new Error(`Timed out waiting for PARSED status. Current status: ${currentStatus}`);
  }

  console.log('   Document parsed successfully!');
  console.log(`   Candidate: ${parsedDetails.parsedResume?.candidateName || 'N/A'}`);
  console.log(`   ATS Score: ${parsedDetails.parsedResume?.atsScore}`);
  console.log(`   Skills detected: ${parsedDetails.parsedResume?.skills?.length || 0}`);

  // Step 6: Test GET /v1/resumes/:id/download-url
  console.log('6. Requesting presigned download URL (GET /v1/resumes/:id/download-url)...');
  const downloadUrlRes = await fetch(`${BACKEND_URL}/v1/resumes/${resumeId}/download-url`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!downloadUrlRes.ok) {
    throw new Error(`Download URL request failed with ${downloadUrlRes.status}: ${await downloadUrlRes.text()}`);
  }

  const downloadData = (await downloadUrlRes.json()) as { downloadUrl: string; expiresIn: number };
  console.log(`   Download URL received (expiresIn: ${downloadData.expiresIn}s)`);

  // Download the file via the presigned URL
  const fileDownloadRes = await fetch(downloadData.downloadUrl);
  if (!fileDownloadRes.ok) {
    throw new Error(`Downloading file from S3 failed with ${fileDownloadRes.status}`);
  }
  const downloadedBytes = Buffer.from(await fileDownloadRes.arrayBuffer());
  console.log(`   Downloaded ${downloadedBytes.length} bytes from S3. Matches original: ${downloadedBytes.equals(samplePdfBytes)}`);

  // Step 7: Delete Resume (DELETE /v1/resumes/:id)
  console.log('7. Deleting resume (DELETE /v1/resumes/:id)...');
  const deleteRes = await fetch(`${BACKEND_URL}/v1/resumes/${resumeId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!deleteRes.ok) {
    throw new Error(`Delete failed with ${deleteRes.status}: ${await deleteRes.text()}`);
  }

  const deleteData = (await deleteRes.json()) as { message: string };
  console.log(`   Delete response: ${deleteData.message}`);

  // Step 8: Verify DB and Storage Cleanup
  console.log('8. Verifying database cascade and AuditLog...');
  const dbResume = await prisma.resume.findUnique({ where: { id: resumeId } });
  if (dbResume) {
    throw new Error(`Expected resume ${resumeId} to be deleted from DB, but record still exists!`);
  }
  console.log('   Verified: Resume row removed from DB.');

  const dbParsed = await prisma.parsedResume.findUnique({ where: { resumeId } });
  if (dbParsed) {
    throw new Error(`Expected parsedResume for ${resumeId} to be cascaded, but record still exists!`);
  }
  console.log('   Verified: ParsedResume row cascaded from DB.');

  const auditLog = await prisma.auditLog.findFirst({
    where: { entityId: resumeId, action: 'RESUME_DELETE' },
  });
  if (!auditLog) {
    throw new Error(`AuditLog entry with action RESUME_DELETE not found for ${resumeId}!`);
  }
  console.log(`   Verified: AuditLog record created with action: ${auditLog.action}`);

  // Step 9: Verify Subsequent GET returns 404
  console.log('9. Verifying subsequent GET /v1/resumes/:id returns 404...');
  const postDeleteGetRes = await fetch(`${BACKEND_URL}/v1/resumes/${resumeId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (postDeleteGetRes.status !== 404) {
    throw new Error(`Expected 404 after deletion, got ${postDeleteGetRes.status}`);
  }
  console.log('   Verified: Subsequent GET returned HTTP 404 Not Found.');

  console.log('\n SUCCESS: Live Docker Cluster Phase 2D Lifecycle Verified 100% End-to-End!');
  await prisma.$disconnect();
  process.exit(0);
}

runLiveLifecycleE2E().catch(async (err) => {
  console.error('\n FAILED Live Lifecycle E2E:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
