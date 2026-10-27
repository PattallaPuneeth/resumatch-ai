// Single upload of one fixture, used by loadtest/memory/measure.sh while it samples docker stats.
// -e FIXTURE=text|docx|scan1|scan5|heavy
import { authHeaders, deleteUsers, registerUsers } from '../lib/auth.js';
import { FIXTURES, uploadAndParse } from '../lib/api.js';

// Loaded only here so the ~4.5 MB worst-case file isn't copied into every VU of other scenarios.
const HEAVY = { file: open('../../fixtures/heavy_5mb.pdf', 'b'), name: 'heavy_5mb.pdf', mime: 'application/pdf' };
const KEY = __ENV.FIXTURE || 'text';

export const options = { vus: 1, iterations: 1, thresholds: { checks: ['rate==1.0'] } };

export function setup() {
  return { users: registerUsers(1) };
}

export default function (data) {
  const fx = KEY === 'heavy' ? HEAVY : FIXTURES[KEY];
  uploadAndParse(authHeaders(data.users), KEY, fx);
}

export function teardown(data) {
  deleteUsers(data.users);
}
