// Match: each iteration is "user pastes a new JD and waits for the score":
// create job (embedding enqueued), trigger match, poll until finalScore. Stepped arrival rate.
import { authHeaders, deleteUsers, registerUsers } from '../lib/auth.js';
import { createJob, ensureResume, matchAndWait } from '../lib/api.js';
import { USERS } from '../lib/config.js';

const STEPS = (__ENV.MATCH_STEPS || '1,2,4').split(',').map(Number); // iterations/s per step
const STEP_DURATION = __ENV.STEP_DURATION || '2m';

const stages = [];
for (const rate of STEPS) {
  stages.push({ target: rate, duration: '20s' });
  stages.push({ target: rate, duration: STEP_DURATION });
}
stages.push({ target: 0, duration: '20s' });

export const options = {
  setupTimeout: '120s',
  scenarios: {
    match: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 40,
      maxVUs: 200,
      stages,
    },
  },
  thresholds: {
    match_e2e: ['p(95)<10000'],
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
  const jobId = createJob(headers, `m-${__VU}-${__ITER}-${Date.now()}`);
  if (jobId) matchAndWait(headers, jobId, resumeId);
}

export function teardown(data) {
  deleteUsers(data.users);
}
