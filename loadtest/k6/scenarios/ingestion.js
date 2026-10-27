// Ingestion: arrival-rate ramp of real uploads (presign, PUT, complete, poll until PARSED).
// SPEC §6 targets: text-layer p95 < 3.5 s, OCR p95 < 8 s. Numbers are reported either way.
import { authHeaders, deleteUsers, registerUsers } from '../lib/auth.js';
import { pickFixture, uploadAndParse } from '../lib/api.js';
import { USERS } from '../lib/config.js';

const PEAK = parseFloat(__ENV.PEAK_RATE || '2'); // uploads per second at the top of the ramp
const MIX = { text: 50, docx: 25, scan1: 20, scan5: 5 };
// k6 stage targets must be integers, so the ramp is expressed in iterations per minute.
const perMin = (fraction) => Math.max(1, Math.round(PEAK * 60 * fraction));

export const options = {
  setupTimeout: '120s',
  scenarios: {
    ingestion: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1m',
      preAllocatedVUs: 40,
      maxVUs: 200,
      stages: [
        { target: perMin(0.25), duration: '1m' },
        { target: perMin(0.5), duration: '1m' },
        { target: perMin(1), duration: '2m' },
        { target: 0, duration: '30s' },
      ],
    },
  },
  thresholds: {
    'ingestion_e2e{type:text}': ['p(95)<3500'],
    'ingestion_e2e{type:ocr}': ['p(95)<8000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  return { users: registerUsers(USERS) };
}

export default function (data) {
  uploadAndParse(authHeaders(data.users), pickFixture(MIX));
}

export function teardown(data) {
  deleteUsers(data.users);
}
