// Analysis: new JD, match, then structured analysis against the MOCK LLM (fixed latency).
// Measures queue + ML + gateway overhead without third-party latency. Each JD is unique,
// so every analysis misses the LLM cache (worst case).
import { authHeaders, deleteUsers, registerUsers } from '../lib/auth.js';
import { analyzeAndWait, createJob, ensureResume, matchAndWait } from '../lib/api.js';
import { USERS } from '../lib/config.js';

const RATE = parseFloat(__ENV.ANALYSIS_RATE || '1');

export const options = {
  setupTimeout: '120s',
  scenarios: {
    analysis: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '3m',
      preAllocatedVUs: 40,
      maxVUs: 200,
    },
  },
  thresholds: {
    analysis_e2e: ['p(95)<15000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  return { users: registerUsers(USERS) };
}

export default function (data) {
  const headers = authHeaders(data.users);
  const resumeId = ensureResume(headers);
  if (!resumeId) return;
  const jobId = createJob(headers, `a-${__VU}-${__ITER}-${Date.now()}`);
  if (jobId && matchAndWait(headers, jobId, resumeId) !== null) {
    analyzeAndWait(headers, jobId, resumeId);
  }
}

export function teardown(data) {
  deleteUsers(data.users);
}
