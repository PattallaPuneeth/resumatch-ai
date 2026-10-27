// Mixed: weighted realistic traffic ramped toward saturation to find the knee.
//   10% upload, 50% browse, 30% match, 10% analysis (iterations/s split by weight).
// SOAK=1 holds a constant RATE for SOAK_DURATION (default 30m) instead of ramping.
import { authHeaders, deleteUsers, registerUsers } from '../lib/auth.js';
import {
  analyzeAndWait,
  browse,
  createJob,
  ensureResume,
  matchAndWait,
  pickFixture,
  uploadAndParse,
} from '../lib/api.js';
import { USERS } from '../lib/config.js';

const RATE = parseFloat(__ENV.RATE || '6'); // total iterations/s at peak (or constant, for soak)
const SOAK = __ENV.SOAK === '1';
const WEIGHTS = { uploadFlow: 0.1, browseFlow: 0.5, matchFlow: 0.3, analysisFlow: 0.1 };

function scenarioFor(name, weight) {
  // k6 rates/targets must be integers, so everything is expressed in iterations per minute.
  const perMin = (fraction) => Math.max(1, Math.round(RATE * weight * 60 * fraction));
  const rate = perMin(1);
  const base = { exec: name, timeUnit: '1m', preAllocatedVUs: 20, maxVUs: 150 };
  if (SOAK) {
    return { ...base, executor: 'constant-arrival-rate', rate, duration: __ENV.SOAK_DURATION || '30m' };
  }
  return {
    ...base,
    executor: 'ramping-arrival-rate',
    startRate: 0,
    stages: [
      { target: perMin(0.25), duration: '1m' },
      { target: perMin(0.5), duration: '1m' },
      { target: perMin(0.75), duration: '1m' },
      { target: rate, duration: '2m' },
      { target: 0, duration: '30s' },
    ],
  };
}

export const options = {
  setupTimeout: '120s',
  teardownTimeout: '120s',
  scenarios: Object.fromEntries(Object.entries(WEIGHTS).map(([n, w]) => [n, scenarioFor(n, w)])),
  thresholds: {
    'http_req_duration{name:resume_list}': ['p(95)<500'],
    'http_req_duration{name:usage}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  return { users: registerUsers(USERS) };
}

export function uploadFlow(data) {
  uploadAndParse(authHeaders(data.users), pickFixture({ text: 50, docx: 25, scan1: 20, scan5: 5 }));
}

export function browseFlow(data) {
  const headers = authHeaders(data.users);
  browse(headers, ensureResume(headers));
}

export function matchFlow(data) {
  const headers = authHeaders(data.users);
  const resumeId = ensureResume(headers);
  const jobId = resumeId && createJob(headers, `x-${__VU}-${__ITER}-${Date.now()}`);
  if (jobId) matchAndWait(headers, jobId, resumeId);
}

export function analysisFlow(data) {
  const headers = authHeaders(data.users);
  const resumeId = ensureResume(headers);
  const jobId = resumeId && createJob(headers, `y-${__VU}-${__ITER}-${Date.now()}`);
  if (jobId && matchAndWait(headers, jobId, resumeId) !== null) analyzeAndWait(headers, jobId, resumeId);
}

export function teardown(data) {
  deleteUsers(data.users);
}
