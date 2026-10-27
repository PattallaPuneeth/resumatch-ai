// Smoke: one user walks the whole flow once, including an Idempotency-Key replay that must
// not double-meter. Runs in CI (mock LLM, MockJobSource) and gates every other scenario.
import { check } from 'k6';
import { authHeaders, deleteUsers, registerUsers } from '../lib/auth.js';
import { analysesUsed, analyzeAndWait, browse, createJob, matchAndWait, uploadAndParse } from '../lib/api.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1.0'],
    http_req_failed: ['rate==0'],
  },
};

export function setup() {
  return { users: registerUsers(1) };
}

export default function (data) {
  const headers = authHeaders(data.users);

  const upload = uploadAndParse(headers, 'text');
  if (!upload || upload.status !== 'PARSED') return;

  const jobId = createJob(headers, `smoke-${Date.now()}`);
  if (!jobId || matchAndWait(headers, jobId, upload.resumeId) === null) return;

  const before = analysesUsed(headers);
  const key = `lt-smoke-${Date.now()}`;
  const first = analyzeAndWait(headers, jobId, upload.resumeId, key);
  check(first.result, { 'analysis llmStatus SUCCESS (mock LLM)': (r) => r !== null && r.llmStatus === 'SUCCESS' });

  const replay = analyzeAndWait(headers, jobId, upload.resumeId, key);
  check(replay.trigger, { 'replay has X-Idempotency-Replay: true': (r) => r.headers['X-Idempotency-Replay'] === 'true' });
  const after = analysesUsed(headers);
  check(after - before, { 'analyses meter grew exactly once': (d) => d === 1 });

  browse(headers, upload.resumeId);
}

export function teardown(data) {
  deleteUsers(data.users);
}
