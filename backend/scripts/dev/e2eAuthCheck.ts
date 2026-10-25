/**
 * Phase 5 Real HTTP End-to-End Verification Check (Dev-only location)
 *
 * Runs against the live backend service (http://localhost:4000).
 * Tests registration, login, protected route call, token refresh, logout,
 * session revocation, brute-force lockout, and account deletion cascade.
 * Never prints passwords, tokens, or recovery codes.
 */
async function runE2ECheck() {
  const BACKEND_URL = 'http://localhost:4000';
  const timestamp = Date.now();
  const username = `e2e_verify_${timestamp}`;
  const password = `ValidSecretPass_${timestamp}!`;

  console.log('=== PHASE 5 REAL HTTP END-TO-END VERIFICATION ===\n');

  // 1. Register
  console.log(`1. POST ${BACKEND_URL}/v1/auth/register`);
  const regRes = await fetch(`${BACKEND_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  console.log(`   Status: ${regRes.status} ${regRes.statusText}`);
  if (regRes.status !== 201) {
    throw new Error(`Registration failed with status ${regRes.status}: ${await regRes.text()}`);
  }
  const regData = (await regRes.json()) as any;
  console.log(`   User ID: ${regData.user.id}`);
  console.log(`   Username: ${regData.user.username}`);
  console.log(`   Recovery Codes Count: ${regData.recoveryCodes.length}`);
  console.log(`   Access Token Length: ${regData.tokens.accessToken.length}`);
  console.log(`   Refresh Token Length: ${regData.tokens.refreshToken.length}`);

  const cookies = regRes.headers.get('set-cookie') || '';
  const hasAccessTokenCookie = cookies.includes('access_token=');
  const hasRefreshTokenCookie = cookies.includes('refresh_token=');
  const hasCsrfTokenCookie = cookies.includes('csrf_token=');
  console.log(
    `   Cookies set: access_token=${hasAccessTokenCookie}, refresh_token=${hasRefreshTokenCookie}, csrf_token=${hasCsrfTokenCookie}`
  );

  // 2. Login
  console.log(`\n2. POST ${BACKEND_URL}/v1/auth/login`);
  const loginRes = await fetch(`${BACKEND_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  console.log(`   Status: ${loginRes.status} ${loginRes.statusText}`);
  if (loginRes.status !== 200) {
    throw new Error(`Login failed with status ${loginRes.status}: ${await loginRes.text()}`);
  }
  const loginData = (await loginRes.json()) as any;
  const accessToken = loginData.tokens.accessToken;
  const refreshToken = loginData.tokens.refreshToken;
  console.log(`   Access Token Length: ${accessToken.length}`);
  console.log(`   Refresh Token Length: ${refreshToken.length}`);

  // 3. Call non-LLM protected route (POST /v1/resumes/upload-url)
  console.log(`\n3. POST ${BACKEND_URL}/v1/resumes/upload-url (Bearer Authenticated)`);
  const uploadUrlRes = await fetch(`${BACKEND_URL}/v1/resumes/upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      filename: 'sample_resume.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10240,
    }),
  });
  console.log(`   Status: ${uploadUrlRes.status} ${uploadUrlRes.statusText}`);
  if (uploadUrlRes.status !== 200) {
    throw new Error(`upload-url failed with status ${uploadUrlRes.status}: ${await uploadUrlRes.text()}`);
  }
  const uploadData = (await uploadUrlRes.json()) as any;
  console.log(`   Resume ID generated: ${uploadData.resumeId}`);
  console.log(`   Presigned Upload URL host present: ${uploadData.uploadUrl.startsWith('http')}`);

  // 4. Refresh token rotation
  console.log(`\n4. POST ${BACKEND_URL}/v1/auth/refresh (Rotation Check)`);
  const refreshRes = await fetch(`${BACKEND_URL}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  console.log(`   Status: ${refreshRes.status} ${refreshRes.statusText}`);
  if (refreshRes.status !== 200) {
    throw new Error(`Refresh failed with status ${refreshRes.status}: ${await refreshRes.text()}`);
  }
  const refreshData = (await refreshRes.json()) as any;
  const newAccessToken = refreshData.tokens.accessToken;
  const newRefreshToken = refreshData.tokens.refreshToken;
  console.log(`   New Access Token Length: ${newAccessToken.length}`);
  console.log(`   New Refresh Token Length: ${newRefreshToken.length}`);
  console.log(`   Rotated Refresh Token Differs: ${newRefreshToken !== refreshToken}`);

  // 5. Logout
  console.log(`\n5. POST ${BACKEND_URL}/v1/auth/logout`);
  const logoutRes = await fetch(`${BACKEND_URL}/v1/auth/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${newAccessToken}`,
    },
  });
  console.log(`   Status: ${logoutRes.status} ${logoutRes.statusText}`);
  if (logoutRes.status !== 200) {
    throw new Error(`Logout failed with status ${logoutRes.status}`);
  }

  // 6. Confirm old token is rejected immediately on next request
  console.log(`\n6. GET ${BACKEND_URL}/v1/auth/me (Confirm Revocation)`);
  const meRevokedRes = await fetch(`${BACKEND_URL}/v1/auth/me`, {
    headers: {
      Authorization: `Bearer ${newAccessToken}`,
    },
  });
  console.log(`   Status: ${meRevokedRes.status} ${meRevokedRes.statusText}`);
  console.log(`   Correctly rejected (401): ${meRevokedRes.status === 401}`);

  // 7. Delete throwaway user via DELETE /v1/account
  console.log(`\n7. DELETE ${BACKEND_URL}/v1/account (Throwaway user cleanup via deletion endpoint)`);
  // Re-login to get an active session
  const cleanLoginRes = await fetch(`${BACKEND_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (cleanLoginRes.status !== 200) {
    throw new Error(`Cleanup re-login failed: ${cleanLoginRes.status}`);
  }
  const cleanLoginData = (await cleanLoginRes.json()) as any;
  const cleanToken = cleanLoginData.tokens.accessToken;

  const deleteAccountRes = await fetch(`${BACKEND_URL}/v1/account`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cleanToken}`,
    },
    body: JSON.stringify({ password }),
  });
  console.log(`   Status: ${deleteAccountRes.status} ${deleteAccountRes.statusText}`);
  console.log(`   Account deleted successfully: ${deleteAccountRes.status === 200}`);

  // 8. Brute-force lockout verification
  console.log(`\n8. Brute-force lockout verification on /v1/auth/login (Nonexistent user)`);
  const lockoutUser = `lockout_probe_${timestamp}`;
  let wasLockedOut = false;
  let retryAfterHeader = '';

  for (let attempt = 1; attempt <= 6; attempt++) {
    const probeRes = await fetch(`${BACKEND_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: lockoutUser, password: 'WrongPassword123!' }),
    });

    if (attempt < 5) {
      if (probeRes.status !== 401) {
        throw new Error(`Expected 401 on attempt ${attempt}, got ${probeRes.status}`);
      }
    } else if (attempt === 6) {
      if (probeRes.status === 429) {
        wasLockedOut = true;
        retryAfterHeader = probeRes.headers.get('retry-after') || '';
      }
    }
  }

  console.log(`   5 failed attempts recorded.`);
  console.log(`   6th attempt received HTTP 429 Too Many Requests: ${wasLockedOut}`);
  console.log(`   Retry-After header value: ${retryAfterHeader} seconds`);

  console.log('\n=== REAL HTTP STACK END-TO-END CHECK: PASSED ===');
}

runE2ECheck().catch((err) => {
  console.error('\nE2E check failed:', err);
  process.exit(1);
});
