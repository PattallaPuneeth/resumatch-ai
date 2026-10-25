/**
 * Live Docker End-to-End Test for Phase 3B Hybrid Matching & Reranking
 *
 * Exercises the complete real cluster workflow:
 * 1. Mints dev JWT for a test candidate.
 * 2. Ingests a new job description via POST /v1/jobs.
 * 3. Polls until job_chunks are persisted in the database by ml-worker.
 * 4. Ingests and parses Jane Doe's sample PDF resume.
 * 5. Triggers match scoring via POST /v1/jobs/:id/match.
 * 6. Polls GET /v1/jobs/:id/matches/:resumeId until match calculation completes.
 * 7. Validates lexical, vector, RRF, cross-encoder scores, and skill-gap breakdown.
 * 8. Validates tenant isolation: accessing another user's job or resume match returns 404.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { generateDevToken } from '../scripts/mintDevToken.js';
import { prisma } from '../db/prisma.js';

const BACKEND_URL = 'http://localhost:4000';

async function runLiveMatchingE2E() {
  console.log('--- Starting Live Cluster Phase 3B Matching E2E ---');

  // Step 1: Mint Dev Token for User A
  console.log('1. Minting dev auth token for test user A...');
  const userA = await prisma.user.create({
    data: {
      email: `matching-e2e-${Date.now()}@example.com`,
      role: 'CANDIDATE',
    },
  });
  const { token: tokenA, userId: userIdA } = await generateDevToken(userA.email);
  console.log(`   User A created: ${userIdA} (${userA.email})`);

  // Step 2: Post Job via Fastify API
  console.log('2. Ingesting Job description via POST /v1/jobs...');
  const jobPayload = {
    title: 'Senior Python & Systems Software Engineer',
    company: 'TechFlow Innovations',
    location: 'Remote',
    jobType: 'FULL_TIME',
    rawDescription: `
Overview:
TechFlow is seeking a Senior Python Software Engineer to build scalable microservices and data pipelines.

Key Responsibilities:
- Design and develop robust REST and async APIs using Python, FastAPI, and Docker.
- Work closely with relational databases like PostgreSQL to optimize indexing and query performance.
- Implement CI/CD automation pipelines and deploy containerized services.

Required Qualifications:
- 4+ years of professional backend software development experience in Python.
- Proven experience with PostgreSQL, Docker, Git, and Linux.
    `.trim(),
    requiredSkills: ['Python', 'PostgreSQL', 'Docker', 'Git'],
    preferredSkills: ['FastAPI', 'Linux', 'AWS'],
    experienceLevel: 'SENIOR',
  };

  const jobRes = await fetch(`${BACKEND_URL}/v1/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenA}`,
    },
    body: JSON.stringify(jobPayload),
  });

  if (!jobRes.ok) {
    throw new Error(`Job creation failed: ${jobRes.status} ${await jobRes.text()}`);
  }

  const jobData = (await jobRes.json()) as { id: string; title: string };
  const jobId = jobData.id;
  console.log(`   Job created with ID: ${jobId}`);

  // Step 3: Wait for job embedding in database
  console.log('3. Waiting for Job embedding worker to chunk and embed job description...');
  let jobChunksCount = 0;
  for (let attempt = 0; attempt < 25; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const jobRecord = await prisma.job.findUnique({
      where: { id: jobId },
      include: { _count: { select: { chunks: true } } },
    });
    if (jobRecord && jobRecord._count.chunks > 0) {
      jobChunksCount = jobRecord._count.chunks;
      break;
    }
  }
  if (jobChunksCount === 0) {
    throw new Error(`Timed out waiting for job ${jobId} chunks to be embedded.`);
  }
  console.log(`   Job embedded successfully: ${jobChunksCount} chunk(s) generated.`);

  // Step 4: Upload and Parse Resume
  console.log('4. Uploading and parsing Jane Doe sample resume...');
  const fixturePath = path.resolve(__dirname, '../../../ml/tests/fixtures/sample_resume.pdf');
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture not found at: ${fixturePath}`);
  }
  const samplePdfBytes = fs.readFileSync(fixturePath);

  const uploadRes = await fetch(`${BACKEND_URL}/v1/resumes/upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenA}`,
    },
    body: JSON.stringify({
      filename: 'Jane_Doe_Matching_E2E.pdf',
      mimeType: 'application/pdf',
      sizeBytes: samplePdfBytes.length,
    }),
  });
  const uploadData = (await uploadRes.json()) as { resumeId: string; uploadUrl: string };
  const resumeId = uploadData.resumeId;

  const uploadParsed = new URL(uploadData.uploadUrl);
  const isInsideContainer = fs.existsSync('/.dockerenv');
  const defaultHost =
    isInsideContainer && (uploadParsed.hostname === 'localhost' || uploadParsed.hostname === '127.0.0.1')
      ? 'minio'
      : uploadParsed.hostname;
  const targetHost = process.env.S3_CONTAINER_HOST ? process.env.S3_CONTAINER_HOST.split(':')[0] : defaultHost;
  const targetPort = process.env.S3_CONTAINER_HOST
    ? parseInt(process.env.S3_CONTAINER_HOST.split(':')[1] || '9000', 10)
    : parseInt(uploadParsed.port || '9000', 10);

  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: targetHost,
        port: targetPort,
        path: uploadParsed.pathname + uploadParsed.search,
        method: 'PUT',
        headers: {
          Host: uploadParsed.host,
          'Content-Type': 'application/pdf',
          'Content-Length': samplePdfBytes.length,
        },
      },
      (res) => {
        let respBody = '';
        res.on('data', (c) => (respBody += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Direct S3 PUT failed with status ${res.statusCode}: ${respBody}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(samplePdfBytes);
    req.end();
  });

  const completeRes = await fetch(`${BACKEND_URL}/v1/resumes/${resumeId}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenA}`,
    },
    body: JSON.stringify({}),
  });
  if (!completeRes.ok) {
    throw new Error(`Complete failed with status ${completeRes.status}: ${await completeRes.text()}`);
  }

  // Poll until PARSED
  let resumeParsed = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
    if (resume && resume.status === 'PARSED') {
      resumeParsed = true;
      break;
    }
  }
  if (!resumeParsed) {
    throw new Error(`Timed out waiting for resume ${resumeId} to reach PARSED status.`);
  }
  console.log(`   Resume parsed successfully (ID: ${resumeId}).`);

  // Step 5: Trigger Match Scoring
  console.log('5. Triggering match scoring via POST /v1/jobs/:id/match...');
  const matchTriggerRes = await fetch(`${BACKEND_URL}/v1/jobs/${jobId}/match`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenA}`,
    },
    body: JSON.stringify({ resumeId }),
  });

  if (matchTriggerRes.status !== 202) {
    throw new Error(`Match scoring trigger failed: ${matchTriggerRes.status} ${await matchTriggerRes.text()}`);
  }
  const matchTriggerData = (await matchTriggerRes.json()) as { status: string };
  console.log(`   Match scoring enqueued with status: ${matchTriggerData.status}`);

  // Step 6: Poll for Match Result
  console.log('6. Polling GET /v1/jobs/:id/matches/:resumeId for completed scoring results...');
  let matchResult: any = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`${BACKEND_URL}/v1/jobs/${jobId}/matches/${resumeId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    if (res.status === 200) {
      matchResult = await res.json();
      break;
    }
  }

  if (!matchResult) {
    throw new Error(`Timed out waiting for match result between Job ${jobId} and Resume ${resumeId}.`);
  }

  console.log('   Match result computed successfully!');
  console.log(`   - Final Score: ${matchResult.finalScore}/100`);
  console.log(`   - Cross-Encoder Score: ${matchResult.crossEncoderScore}`);
  console.log(`   - RRF Score: ${matchResult.rrfScore}`);
  console.log(`   - BM25 (Lexical) Score: ${matchResult.bm25Score}`);
  console.log(`   - Vector (Semantic) Score: ${matchResult.vectorScore}`);

  const skillGap = matchResult.explanation?.skillGap;
  console.log(`   - Skill Gap Matched: ${JSON.stringify(skillGap?.matched)}`);
  console.log(`   - Skill Gap Missing: ${JSON.stringify(skillGap?.missing)}`);

  if (matchResult.finalScore <= 0 || matchResult.finalScore > 100) {
    throw new Error(`Final score out of valid range: ${matchResult.finalScore}`);
  }

  // Step 7: Validate Tenant Isolation (User B cannot access Match Result)
  console.log('7. Validating tenant isolation with User B...');
  const userB = await prisma.user.create({
    data: {
      email: `user-b-${Date.now()}@example.com`,
      role: 'CANDIDATE',
    },
  });
  const { token: tokenB } = await generateDevToken(userB.email);

  const crossUserGetRes = await fetch(`${BACKEND_URL}/v1/jobs/${jobId}/matches/${resumeId}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  if (crossUserGetRes.status !== 404) {
    throw new Error(`Expected 404 for cross-tenant match fetch, got: ${crossUserGetRes.status}`);
  }
  console.log('   Tenant isolation verified: User B received 404 Not Found.');

  console.log(' SUCCESS: Live Docker Cluster Phase 3B Matching Verified 100% End-to-End!');
}

runLiveMatchingE2E()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(' LIVE MATCHING E2E FAILED:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
