/**
 * Fills a running ResuMatch stack with a demo account: 3 synthetic resumes, 5 job descriptions
 * and every resume matched against every job.
 *
 * It goes through the real HTTP API (register, upload, parse, match), so every score comes from
 * the actual pipeline and nothing is invented. Resumes are the committed synthetic CI fixtures.
 *
 *   node scripts/seed-demo.mjs                       # new account, password is generated
 *   DEMO_USERNAME=me DEMO_PASSWORD=... node scripts/seed-demo.mjs
 *
 * Env: BASE_URL (default http://localhost:3000/api/backend), DEMO_USERNAME, DEMO_PASSWORD.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/backend';
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'ml', 'eval', 'ci_fixtures');

const RESUMES = ['resume_senior_backend.pdf', 'resume_frontend_dev.pdf', 'resume_sales_exec.pdf'];

const FILE_JOBS = [
  { file: 'job_backend_lead.txt', company: 'Northwind Cloud' },
  { file: 'job_frontend_dev.txt', company: 'Contoso Labs' },
];

const INLINE_JOBS = [
  {
    title: 'Data Engineer',
    company: 'Fabrikam Analytics',
    rawDescription:
      'Build and maintain batch and streaming data pipelines in Python and SQL on PostgreSQL. Experience with Docker, orchestration and data quality checks is required. Kafka and Spark are a plus.',
  },
  {
    title: 'DevOps Engineer',
    company: 'Tailspin Systems',
    rawDescription:
      'Own CI/CD, Docker and Kubernetes clusters, monitoring and incident response. Required: Linux, Kubernetes, Docker, Python scripting. Preferred: Terraform, Prometheus.',
  },
  {
    title: 'Account Executive',
    company: 'Adventure Works',
    rawDescription:
      'Own the full sales cycle for mid-market accounts: prospecting, demos, negotiation and closing. Required: B2B sales experience, CRM tools, pipeline forecasting and quota ownership.',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { headers, ...options } = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, { ...options, headers });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON body
  }
  return { status: res.status, headers: res.headers, body };
}

function fail(message, detail) {
  console.error(`Seed failed: ${message}`);
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  process.exit(1);
}

async function authenticate() {
  const username = process.env.DEMO_USERNAME || `demo_${crypto.randomBytes(3).toString('hex')}`;
  const password = process.env.DEMO_PASSWORD || `${crypto.randomBytes(12).toString('base64url')}-Aa9!`;
  const json = { 'Content-Type': 'application/json' };

  let res = await api('/v1/auth/register', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 409 && process.env.DEMO_PASSWORD) {
    res = await api('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ username, password }),
    });
  }
  if (res.status !== 200 && res.status !== 201) {
    fail(`could not sign in as "${username}" (status ${res.status})`, res.body);
  }
  const headers = { ...json };
  const token = res.body?.tokens?.accessToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (cookie) headers.Cookie = cookie;
  return { username, password, headers, generated: !process.env.DEMO_PASSWORD };
}

async function uploadResume(headers, file) {
  const bytes = fs.readFileSync(path.join(fixtures, 'resumes', file));
  const urlRes = await api('/v1/resumes/upload-url', {
    method: 'POST',
    headers,
    body: JSON.stringify({ filename: file, mimeType: 'application/pdf', sizeBytes: bytes.length }),
  });
  if (urlRes.status !== 200 && urlRes.status !== 201) fail(`upload URL for ${file}`, urlRes.body);
  const { resumeId, uploadUrl } = urlRes.body;

  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes });
  if (!put.ok) fail(`storage upload for ${file} (status ${put.status})`);

  const done = await api(`/v1/resumes/${resumeId}/complete`, { method: 'POST', headers, body: '{}' });
  if (done.status !== 200 && done.status !== 202) fail(`complete upload for ${file}`, done.body);

  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const check = await api(`/v1/resumes/${resumeId}`, { headers });
    if (check.body?.status === 'PARSED') return { id: resumeId, file, ats: check.body.parsedResume?.atsScore };
    if (check.body?.status === 'FAILED') fail(`parsing ${file} failed`, check.body);
  }
  fail(`timed out waiting for ${file} to parse`);
}

async function createJob(headers, job) {
  const res = await api('/v1/jobs', { method: 'POST', headers, body: JSON.stringify(job) });
  if (res.status !== 200 && res.status !== 201) fail(`create job "${job.title}"`, res.body);
  return { ...job, id: res.body.id };
}

async function match(headers, job, resume) {
  const trigger = await api(`/v1/jobs/${job.id}/match`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ resumeId: resume.id }),
  });
  if (trigger.status !== 200 && trigger.status !== 202) fail(`match ${resume.file} x ${job.title}`, trigger.body);
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const res = await api(`/v1/jobs/${job.id}/matches/${resume.id}`, { headers });
    if (res.status === 200 && res.body?.finalScore !== undefined) return res.body.finalScore;
  }
  fail(`timed out matching ${resume.file} x ${job.title}`);
}

const health = await api('/health').catch(() => null);
if (!health || health.status !== 200) {
  fail(`the stack is not reachable at ${BASE_URL}. Start it with "docker compose up -d".`);
}

const session = await authenticate();
console.log(`Signed in as ${session.username}`);

const resumes = [];
for (const file of RESUMES) {
  const r = await uploadResume(session.headers, file);
  console.log(`  parsed ${file} (ATS ${r.ats ?? 'n/a'})`);
  resumes.push(r);
}

const jobs = [];
for (const { file, company } of FILE_JOBS) {
  const text = fs.readFileSync(path.join(fixtures, 'jobs', file), 'utf8').trim();
  const [title, ...rest] = text.split('\n');
  jobs.push(await createJob(session.headers, { title: title.trim(), company, rawDescription: rest.join('\n').trim() }));
}
for (const job of INLINE_JOBS) jobs.push(await createJob(session.headers, job));
console.log(`  created ${jobs.length} jobs`);

for (const resume of resumes) {
  for (const job of jobs) {
    const score = await match(session.headers, job, resume);
    console.log(`  ${resume.file.padEnd(28)} x ${job.title.padEnd(34)} ${Number(score).toFixed(1)}`);
  }
}

console.log('\nDemo data is ready. Sign in at http://localhost:3000/login');
console.log(`  username: ${session.username}`);
if (session.generated) {
  console.log(`  password: ${session.password}  (generated for this run; save it now)`);
}
