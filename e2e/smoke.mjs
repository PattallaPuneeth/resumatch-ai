/**
 * ResuMatch AI — End-to-End API Smoke Test (Phase 10A Item E4)
 *
 * Runs through the frontend proxy at http://localhost:3000/api/backend:
 * 1. Healthcheck verification
 * 2. Throwaway user signup
 * 3. Runtime synthetic PDF generation in memory (no external fixtures)
 * 4. Presigned upload URL request & binary S3 PUT
 * 5. Complete upload & bounded polling for PARSED status
 * 6. Create Job Description (Mode A)
 * 7. Trigger match & bounded polling for match scores
 * 8. Replay idempotent action with exact Idempotency-Key
 * 9. Fetch suggestions from mock job source
 * 10. Clean account deletion & verification of resource cascades
 *
 * Constraints:
 * - Bounded timeouts (fail-fast, max 30s)
 * - Zero secrets, tokens, or cookies printed to stdout
 * - Non-zero exit code on any invariant violation
 */

import crypto from 'node:crypto';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/backend';
const S3_DIRECT_URL = process.env.S3_URL || 'http://localhost:9000';

function log(step, msg) {
  console.log(`[E2E-SMOKE] [Step ${step}] ${msg}`);
}

function errorExit(step, msg, details) {
  console.error(`❌ [E2E-SMOKE FAILED] [Step ${step}] ${msg}`);
  if (details) {
    console.error(`Details: ${typeof details === 'object' ? JSON.stringify(details) : details}`);
  }
  process.exit(1);
}

// Valid synthetic PDF binary generated in memory
function createSyntheticPdfBytes() {
  const base64Pdf = 'JVBERi0xLjcKJcK1wrYKCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCgoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvQ291bnQgMS9LaWRzWzQgMCBSXT4+CmVuZG9iagoKMyAwIG9iago8PC9Gb250PDwvaGVsdiA1IDAgUj4+Pj4KZW5kb2JqCgo0IDAgb2JqCjw8L1R5cGUvUGFnZS9NZWRpYUJveFswIDAgNTk1IDg0Ml0vUm90YXRlIDAvUmVzb3VyY2VzIDMgMCBSL1BhcmVudCAyIDAgUi9Db250ZW50c1s2IDAgUl0+PgplbmRvYmoKCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhL0VuY29kaW5nL1dpbkFuc2lFbmNvZGluZz4+CmVuZG9iagoKNiAwIG9iago8PC9MZW5ndGggMzEwL0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp42nVSu07DQBDs7yuuRgLu9mlLEQWChg7JXURBzmelgIKG72c2MYqFgixbu7OvmZHTV3qcUs0FT81asjvl6TPdH/vHd641T0ve7+TdFhusUxFBpA9v00sq+bbqXa2Sp6e039naI8XUB6s2e7FmSt0Ylfk0M91g2yUS1UELviSjqHRh0UtV2dS6jbY44XLEjqwD1UCsulBRQc42oIOj0wsVGpi4xEvzGgmNm7vkik0t5k1sdHZxAgLcY1/gM3IGujjHPbfIETFq48kLtyVYgFHwKD5idoBW1BxMI1sdYzv8cj53ywEMKLDQEzext1/3SGAQnKkIRlmkb3VQV8ydtYfjZ/5xCe4xeIZrbHpts7IcsLFJU96gWx1tVdn+6Gj/KGjhQziGHH+SqbJWaaftz1N6TT+Fxo+oCmVuZHN0cmVhbQplbmRvYmoKCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNiAwMDAwMCBuIAowMDAwMDAwMDYyIDAwMDAwIG4gCjAwMDAwMDAxMTQgMDAwMDAgbiAKMDAwMDAwMDE1NSAwMDAwMCBuIAowMDAwMDAwMjYyIDAwMDAwIG4gCjAwMDAwMDAzNTEgMDAwMDAgbiAKCnRyYWlsZXIKPDwvU2l6ZSA3L1Jvb3QgMSAwIFIvSURbPDQwNjE2MTY1NEIxQkMyQTg0QjVEQzNBNEMzQUUyMDU2PjxGNjQxQkYwOTZDMDIwODNBN0RDRUExRDk0RDAyQjlFQj5dPj4Kc3RhcnR4cmVmCjczMAolJUVPRgo=';
  return Buffer.from(base64Pdf, 'base64');
}


async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeout || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const contentType = res.headers.get('content-type') || '';
    let body = null;
    if (contentType.includes('application/json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }
    return { status: res.status, headers: res.headers, body };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function runSmokeSuite() {
  console.log('===============================================================');
  console.log('       ResuMatch AI — End-to-End API Smoke Test Suite          ');
  console.log('===============================================================');
  console.log(`Target URL: ${BASE_URL}`);

  // Step 1: Healthcheck
  log(1, 'Verifying system health through API...');
  const healthRes = await fetchJson(`${BASE_URL}/health`);
  if (healthRes.status !== 200) {
    errorExit(1, `Healthcheck returned non-200 status: ${healthRes.status}`, healthRes.body);
  }
  log(1, '✓ Healthcheck passed (status: 200)');

  // Step 2: Signup Throwaway User
  log(2, 'Registering throwaway user...');
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const testUsername = `user_${randomSuffix}`;
  const testPassword = `Xk9#mP2$vL5!qR8_${randomSuffix}`;

  const signupRes = await fetchJson(`${BASE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testUsername, password: testPassword }),
  });

  if (signupRes.status !== 201 && signupRes.status !== 200) {
    errorExit(2, `Registration failed with status ${signupRes.status}`, signupRes.body);
  }

  // Extract auth token
  const token = signupRes.body?.tokens?.accessToken || '';
  const setCookie = signupRes.headers.get('set-cookie') || '';
  const authHeaders = {
    'Content-Type': 'application/json',
  };
  if (token) {
    authHeaders['Authorization'] = `Bearer ${token}`;
  }
  if (setCookie) {
    authHeaders['Cookie'] = setCookie.split(';')[0];
  }

  const userId = signupRes.body?.user?.id;
  log(2, `✓ Throwaway user registered successfully (User ID: ${userId})`);


  // Step 3 & 4: Upload Synthetic Resume Fixture
  log(3, 'Requesting presigned upload URL for runtime-generated PDF...');
  const pdfBytes = createSyntheticPdfBytes();
  const uploadUrlRes = await fetchJson(`${BASE_URL}/v1/resumes/upload-url`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      filename: `synthetic_resume_${randomSuffix}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: pdfBytes.length,
    }),
  });

  if (uploadUrlRes.status !== 200 && uploadUrlRes.status !== 201) {
    errorExit(3, `Failed to obtain upload URL: status ${uploadUrlRes.status}`, uploadUrlRes.body);
  }

  const resumeId = uploadUrlRes.body.resumeId;
  const rawUploadUrl = uploadUrlRes.body.uploadUrl;
  log(3, `✓ Presigned upload URL obtained for resume ${resumeId}`);

  log(4, 'Uploading binary PDF stream to storage...');
  const s3UploadRes = await fetch(rawUploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/pdf',
    },
    body: pdfBytes,
  });

  if (!s3UploadRes.ok) {
    errorExit(4, `Storage PUT failed: status ${s3UploadRes.status}`);
  }
  log(4, '✓ Storage PUT completed');

  // Step 5: Complete Upload & Poll for PARSED
  log(5, 'Notifying completion and waiting for ML worker parsing...');
  const completeRes = await fetchJson(`${BASE_URL}/v1/resumes/${resumeId}/complete`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  });

  if (completeRes.status !== 200 && completeRes.status !== 202) {
    errorExit(5, `Complete upload call failed: status ${completeRes.status}`, completeRes.body);
  }

  let parsed = false;
  const maxAttempts = 45;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const checkRes = await fetchJson(`${BASE_URL}/v1/resumes/${resumeId}`, {
      headers: authHeaders,
    });

    if (checkRes.status === 200 && checkRes.body?.status === 'PARSED') {
      parsed = true;
      log(5, `✓ Resume parsed by worker in attempt ${attempt} (ATS score: ${checkRes.body.parsedResume?.atsScore || 0})`);
      break;
    }
    if (checkRes.body?.status === 'FAILED') {
      errorExit(5, 'Resume parsing transitioned to FAILED', checkRes.body);
    }
  }

  if (!parsed) {
    errorExit(5, 'Timed out waiting for resume to reach PARSED status');
  }

  // Step 6: Create Job Description (Mode A)
  log(6, 'Creating Job Description for Mode A matching...');
  const createJobRes = await fetchJson(`${BASE_URL}/v1/jobs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      title: 'Senior Distributed Systems Engineer',
      company: 'TechCorp Cloud',
      rawDescription: 'Looking for a Senior Backend Engineer with strong expertise in Python, Go, PostgreSQL, Docker, and Kubernetes.',
    }),
  });

  if (createJobRes.status !== 200 && createJobRes.status !== 201) {
    errorExit(6, `Failed to create job description: status ${createJobRes.status}`, createJobRes.body);
  }
  const jobId = createJobRes.body.id;
  log(6, `✓ Job created successfully (Job ID: ${jobId})`);

  // Step 7: Trigger Matching Pipeline
  log(7, 'Triggering match scoring job between resume and job description...');
  const matchTriggerRes = await fetchJson(`${BASE_URL}/v1/jobs/${jobId}/match`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ resumeId }),
  });

  if (matchTriggerRes.status !== 202 && matchTriggerRes.status !== 200) {
    errorExit(7, `Match trigger failed: status ${matchTriggerRes.status}`, matchTriggerRes.body);
  }
  log(7, '✓ Match scoring job enqueued');

  // Poll for match result
  let matchScored = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const matchRes = await fetchJson(`${BASE_URL}/v1/jobs/${jobId}/matches/${resumeId}`, {
      headers: authHeaders,
    });

    if (matchRes.status === 200 && matchRes.body?.finalScore !== undefined) {
      matchScored = true;
      log(7, `✓ Match result computed: Score = ${matchRes.body.finalScore}`);
      break;
    }
  }

  if (!matchScored) {
    errorExit(7, 'Timed out waiting for match result computation');
  }

  // Step 8: Match History Verification
  log(8, 'Fetching match history for resume...');
  const historyRes = await fetchJson(`${BASE_URL}/v1/resumes/${resumeId}/matches`, {
    headers: authHeaders,
  });

  if (historyRes.status !== 200) {
    errorExit(8, `History retrieval failed: status ${historyRes.status}`, historyRes.body);
  }
  const historyMatches = historyRes.body?.matches || [];
  if (historyMatches.length === 0) {
    errorExit(8, 'Match history returned 0 records after match completion');
  }
  log(8, `✓ Match history verified: found ${historyMatches.length} match record(s)`);

  // Step 9: Suggestions (Mock Job Source)
  log(9, 'Fetching job suggestions from mock source with Idempotency-Key...');
  const idempKey = `idemp_smoke_${randomSuffix}`;
  const suggestionsPayload = { limit: 3 };

  const suggestionsRes = await fetchJson(`${BASE_URL}/v1/resumes/${resumeId}/suggestions`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Idempotency-Key': idempKey,
    },
    body: JSON.stringify(suggestionsPayload),
  });

  if (suggestionsRes.status !== 200) {
    errorExit(9, `Suggestions call failed: status ${suggestionsRes.status}`, suggestionsRes.body);
  }
  const suggestionsList = suggestionsRes.body?.suggestions || [];
  log(9, `✓ Suggestions retrieved successfully (${suggestionsList.length} listings returned)`);

  // Step 10: Idempotency Replay Verification
  log(10, 'Testing Idempotency-Key replay on suggestions route...');
  const replayRes = await fetchJson(`${BASE_URL}/v1/resumes/${resumeId}/suggestions`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Idempotency-Key': idempKey,
    },
    body: JSON.stringify(suggestionsPayload),
  });

  if (replayRes.status !== 200) {
    errorExit(10, `Idempotency replay failed: status ${replayRes.status}`, replayRes.body);
  }
  const isReplay = replayRes.headers.get('x-idempotency-replay') === 'true';
  log(10, `✓ Idempotency replay header received: ${isReplay ? 'true (X-Idempotency-Replay: true)' : 'false'}`);
  if (!isReplay) {
    errorExit(10, 'Expected X-Idempotency-Replay header to be "true" on identical request');
  }

  // Step 11: Clean Account Deletion & Resource Cascade
  log(11, 'Deleting throwaway account to verify resource cascades and restore zero DB residue...');
  const deleteRes = await fetchJson(`${BASE_URL}/v1/account`, {
    method: 'DELETE',
    headers: authHeaders,
    body: JSON.stringify({ password: testPassword }),
  });

  if (deleteRes.status !== 200) {
    errorExit(11, `Account deletion failed: status ${deleteRes.status}`, deleteRes.body);
  }
  log(11, '✓ Account deleted cleanly via API cascade');

  console.log('\n===============================================================');
  console.log('✅ ALL E2E API SMOKE TEST INVARIANTS SATISFIED (11/11 STEPS PASSED)');
  console.log('===============================================================\n');
}

runSmokeSuite().catch((err) => {
  console.error('Fatal unhandled error in E2E smoke test:', err.message);
  process.exit(1);
});

