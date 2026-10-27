import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { BASE_URL, TOKEN_REFRESH_MS } from './config.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function randomHex(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/**
 * Registers `count` throwaway load-test users (setup() only). Paced to stay under the
 * per-IP auth limit (60/min), which load tests deliberately leave untouched.
 */
export function registerUsers(count) {
  const runId = randomHex(6);
  const users = [];
  for (let i = 0; i < count; i++) {
    const username = `lt_${runId}_${i}`;
    const password = `Lt#${randomHex(12)}!9aZ`;
    const res = http.post(`${BASE_URL}/v1/auth/register`, JSON.stringify({ username, password }), {
      headers: JSON_HEADERS,
      tags: { name: 'setup_register' },
    });
    if (res.status !== 201 && res.status !== 200) {
      exec.test.abort(`register failed for user ${i}: HTTP ${res.status}`);
    }
    users.push({ username, password, token: res.json('tokens.accessToken'), issuedAt: Date.now() });
    sleep(1.1);
  }
  return users;
}

function login(user) {
  const res = http.post(
    `${BASE_URL}/v1/auth/login`,
    JSON.stringify({ username: user.username, password: user.password }),
    { headers: JSON_HEADERS, tags: { name: 'login' } }
  );
  if (res.status !== 200) {
    throw new Error(`login failed: HTTP ${res.status}`);
  }
  return res.json('tokens.accessToken');
}

// Per-VU session cache (module scope is per VU in k6).
let session = null;

/** Returns auth headers for this VU's user, re-logging in before the access token expires. */
export function authHeaders(users) {
  const user = users[(exec.vu.idInTest - 1) % users.length];
  if (!session || session.username !== user.username) {
    session = { username: user.username, token: user.token, issuedAt: user.issuedAt };
  }
  if (Date.now() - session.issuedAt > TOKEN_REFRESH_MS) {
    session.token = login(user);
    session.issuedAt = Date.now();
  }
  return { ...JSON_HEADERS, Authorization: `Bearer ${session.token}` };
}

/** Deletes every load-test account so runs leave no residue (teardown() only). */
export function deleteUsers(users) {
  for (const user of users) {
    let token = user.token;
    if (Date.now() - user.issuedAt > TOKEN_REFRESH_MS) {
      try {
        token = login(user);
      } catch (_e) {
        continue;
      }
      sleep(1.1);
    }
    http.del(`${BASE_URL}/v1/account`, JSON.stringify({ password: user.password }), {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      tags: { name: 'teardown_delete_account' },
    });
  }
}
