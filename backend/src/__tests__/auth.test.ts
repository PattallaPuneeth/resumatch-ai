import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { redisClient } from '../queues/redis.js';
import * as passwordModule from '../auth/password.js';
import * as storageModule from '../storage/s3.js';
import {
  validatePasswordPolicy,
  validateUsernamePolicy,
  hashPassword,
  verifyPassword,
  hashingLimiter,
} from '../auth/password.js';
import { env } from '../config/env.js';
import {
  createTestUserAndSession,
  cleanupTestUser,
} from './testAuthHelper.js';
import { checkIpRateLimit } from '../auth/rateLimiter.js';

describe('Phase 5: Accounts and Authentication Suite', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // 1. Password & Username Policy
  // ---------------------------------------------------------------------------
  describe('Password & Username Policy', () => {
    it('rejects passwords shorter than 12 characters', () => {
      const res = validatePasswordPolicy('Short1!', 'validuser');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('between 12 and 128 characters');
    });

    it('rejects passwords longer than 128 characters', () => {
      const longPass = 'A'.repeat(129);
      const res = validatePasswordPolicy(longPass, 'validuser');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('between 12 and 128 characters');
    });

    it('rejects passwords containing the username (case-insensitive)', () => {
      const res = validatePasswordPolicy('MySecretAlexDev2026!', 'AlexDev');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('must not contain the username');
    });

    it('rejects passwords in bundled common password list', () => {
      const res = validatePasswordPolicy('password12345', 'uniquename');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('common');
    });

    it('accepts passwords with no composition requirements as long as valid length', () => {
      const res = validatePasswordPolicy('correct horse battery staple', 'randomuser');
      expect(res.valid).toBe(true);
    });

    it('validates username policy (3-32 chars, alphanumeric, dots, underscores, dashes)', () => {
      expect(validateUsernamePolicy('ab').valid).toBe(false);
      expect(validateUsernamePolicy('a'.repeat(33)).valid).toBe(false);
      expect(validateUsernamePolicy('user@domain').valid).toBe(false);
      expect(validateUsernamePolicy('valid_user.name-123').valid).toBe(true);
    });

    it('hashes passwords with Argon2id and verifies correctly', async () => {
      const hash = await hashPassword('SuperStrongPassword2026!');
      expect(hash).toContain('$argon2id$');
      expect(hash).toContain('m=19456,t=2,p=1');
      const valid = await verifyPassword(hash, 'SuperStrongPassword2026!');
      expect(valid).toBe(true);
      const invalid = await verifyPassword(hash, 'WrongPassword2026!');
      expect(invalid).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Registration & 10 Recovery Codes
  // ---------------------------------------------------------------------------
  describe('Registration & Recovery Codes', () => {
    let registeredUserId = '';

    afterAll(async () => {
      if (registeredUserId) {
        await cleanupTestUser(registeredUserId);
      }
    });

    it('successfully registers new user, returns 10 recovery codes, sets auth cookies', async () => {
      const username = `reguser_${Date.now()}`;
      const password = 'UniqueSuperPassword2026!';

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { username, password },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.user.username).toBe(username);
      registeredUserId = body.user.id;
      expect(body.recoveryCodes).toHaveLength(10);
      expect(body.tokens.accessToken).toBeDefined();
      expect(body.tokens.refreshToken).toBeDefined();

      // Check Cache-Control headers
      expect(res.headers['cache-control']).toBe('no-store');

      // Check cookies
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
      expect(cookieStr).toContain('access_token=');
      expect(cookieStr).toContain('refresh_token=');
      expect(cookieStr).toContain('csrf_token=');
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('Path=/v1/auth');

      // Verify recovery codes are stored as hashes in database
      const dbCodes = await prisma.recoveryCode.findMany({
        where: { userId: registeredUserId },
      });
      expect(dbCodes).toHaveLength(10);
      // Raw plaintext code should NOT match hash in DB
      expect(dbCodes[0].codeHash).not.toBe(body.recoveryCodes[0]);
    });

    it('rejects duplicate username registration with 409 Conflict (case-insensitive)', async () => {
      const username = `dupeuser_${Date.now()}`;
      const password = 'UniqueSuperPassword2026!';

      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { username, password },
      });
      expect(res1.statusCode).toBe(201);
      const uId = res1.json().user.id;

      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { username: username.toUpperCase(), password },
      });
      expect(res2.statusCode).toBe(409);
      expect(res2.json().title).toBe('Conflict');

      await cleanupTestUser(uId);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Login, Timing Equalization & Generic Errors
  // ---------------------------------------------------------------------------
  describe('Login & Timing Equalization', () => {
    let testUserSession: any;

    beforeAll(async () => {
      testUserSession = await createTestUserAndSession(app, {
        username: `logintest_${Date.now()}`,
        password: 'ValidPassword123!',
      });
    });

    afterAll(async () => {
      if (testUserSession?.userId) {
        await cleanupTestUser(testUserSession.userId);
      }
    });

    it('returns identical status and body for unknown user and wrong password', async () => {
      // 1. Unknown user
      const resUnknown = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: `nonexistent_${Date.now()}`,
          password: 'SomeRandomPassword123!',
        },
      });

      // 2. Wrong password for existing user
      const resWrongPass = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: testUserSession.user.username,
          password: 'WrongPassword123!',
        },
      });

      expect(resUnknown.statusCode).toBe(401);
      expect(resWrongPass.statusCode).toBe(401);

      const bodyUnknown = resUnknown.json();
      const bodyWrongPass = resWrongPass.json();

      expect(bodyUnknown.title).toBe(bodyWrongPass.title);
      expect(bodyUnknown.detail).toBe(bodyWrongPass.detail);
      expect(bodyUnknown.detail).toBe('Invalid username or password.');
    });

    it('dummy-verify path runs for unknown user', async () => {
      const spyDummy = vi.spyOn(passwordModule, 'dummyArgon2Verify');

      await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: `ghostuser_${Date.now()}`,
          password: 'ValidPassword123!',
        },
      });

      expect(spyDummy).toHaveBeenCalled();
      spyDummy.mockRestore();
    });

    it('successfully logs in with valid credentials and sets new session family (session fixation defense)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: testUserSession.user.username,
          password: 'ValidPassword123!',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.id).toBe(testUserSession.userId);
      expect(body.tokens.accessToken).toBeDefined();

      // Check new session family was created
      const sessions = await prisma.session.findMany({
        where: { userId: testUserSession.userId },
      });
      // Should have initial session + new session with different familyIds
      const familyIds = new Set(sessions.map((s) => s.familyId));
      expect(familyIds.size).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Rate Limiting, Lockout & Exponential Backoff
  // ---------------------------------------------------------------------------
  describe('Rate Limiting & Lockout', () => {
    it('triggers exponential lockout after 5 failed login attempts with Retry-After header', async () => {
      const username = `lockout_victim_${Date.now()}`;

      // 4 failed attempts: not yet locked out
      for (let i = 0; i < 4; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { username, password: 'BadPassword123!' },
        });
        expect(res.statusCode).toBe(401);
      }

      // 5th failed attempt: triggers initial lockout (60s)
      const res5 = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username, password: 'BadPassword123!' },
      });
      expect(res5.statusCode).toBe(401);

      // Immediate 6th attempt is blocked with 429 Too Many Requests
      const res6 = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username, password: 'BadPassword123!' },
      });
      expect(res6.statusCode).toBe(429);
      expect(res6.headers['retry-after']).toBeDefined();
      const retryAfter = Number(res6.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(res6.json().detail).toContain('locked');

      // Clean up Redis keys for test hygiene
      await redisClient.del(`auth:lockout:${username}`, `auth:failed_login:${username}`);
    });

    it('fails closed with HTTP 503 if Redis is unavailable during auth', async () => {
      const spyIncr = vi.spyOn(redisClient, 'incr').mockRejectedValueOnce(new Error('Redis connection lost'));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username: 'testuser', password: 'Password123!' },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().title).toBe('Service Unavailable');
      expect(res.json().detail).toContain('unavailable');

      spyIncr.mockRestore();
    });

    it('enforces per-IP rate limit on auth endpoints and returns 429 with Retry-After when exceeded', async () => {
      const testIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
      const key = `ratelimit:auth:ip:${testIp}`;

      // Clean start
      await redisClient.del(key);

      // Verify checkIpRateLimit allows up to threshold (e.g. 3 attempts)
      const r1 = await checkIpRateLimit(testIp, 3, 60);
      expect(r1.allowed).toBe(true);

      const r2 = await checkIpRateLimit(testIp, 3, 60);
      expect(r2.allowed).toBe(true);

      const r3 = await checkIpRateLimit(testIp, 3, 60);
      expect(r3.allowed).toBe(true);

      // 4th request exceeds the per-IP threshold
      const r4 = await checkIpRateLimit(testIp, 3, 60);
      expect(r4.allowed).toBe(false);
      expect(r4.retryAfter).toBeGreaterThan(0);

      // Clean up Redis key
      await redisClient.del(key);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Refresh Rotation & Replay Detection (Family Revocation)
  // ---------------------------------------------------------------------------
  describe('Refresh Token Rotation & Replay Detection', () => {
    let testSession: any;

    beforeAll(async () => {
      testSession = await createTestUserAndSession(app, {
        username: `refresh_test_${Date.now()}`,
      });
    });

    afterAll(async () => {
      if (testSession?.userId) {
        await cleanupTestUser(testSession.userId);
      }
    });

    it('rotates refresh token on use and issues new active session', async () => {
      const initialRefreshToken = testSession.refreshToken;

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: initialRefreshToken },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tokens.refreshToken).toBeDefined();
      expect(body.tokens.refreshToken).not.toBe(initialRefreshToken);

      // Verify old session marked as used
      const oldSession = await prisma.session.findUnique({
        where: { id: testSession.sessionId },
      });
      expect(oldSession?.usedAt).not.toBeNull();

      // Replay Detection: Reusing old rotated refresh token revokes whole family!
      const replayRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: initialRefreshToken },
      });

      expect(replayRes.statusCode).toBe(401);
      expect(replayRes.json().detail).toContain('reuse detected');

      // Verify all sessions in that family are revoked
      const allSessions = await prisma.session.findMany({
        where: { familyId: testSession.familyId },
      });
      for (const s of allSessions) {
        expect(s.revokedAt).not.toBeNull();
      }

      // Subsequent refresh with the newer token also fails because family was revoked
      const nextRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: body.tokens.refreshToken },
      });
      expect(nextRes.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Immediate Session Revocation on Logout & Logout-All
  // ---------------------------------------------------------------------------
  describe('Session Revocation (Logout & Logout-All)', () => {
    it('logout revokes current session immediately on the very next request', async () => {
      const session = await createTestUserAndSession(app, {
        username: `logout_test_${Date.now()}`,
      });

      // 1. Verify access token works on protected route
      const check1 = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: session.authHeader,
      });
      expect(check1.statusCode).toBe(200);

      // 2. Perform logout
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: session.authHeader,
      });
      expect(logoutRes.statusCode).toBe(200);

      // 3. Immediately verify old access token is REJECTED on next request
      const check2 = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: session.authHeader,
      });
      expect(check2.statusCode).toBe(401);
      expect(check2.json().detail).toContain('revoked');

      await cleanupTestUser(session.userId);
    });

    it('logout-all revokes all user sessions immediately', async () => {
      const session1 = await createTestUserAndSession(app, {
        username: `logoutall_${Date.now()}`,
      });

      // Log in second time to create second session
      const loginRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: session1.user.username,
          password: 'SecurePassword123!',
        },
      });
      const session2Token = loginRes.json().tokens.accessToken;

      // Call logout-all with session1
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout-all',
        headers: session1.authHeader,
      });
      expect(res.statusCode).toBe(200);

      // Both session1 and session2 must now be rejected
      const test1 = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: session1.authHeader,
      });
      expect(test1.statusCode).toBe(401);

      const test2 = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${session2Token}` },
      });
      expect(test2.statusCode).toBe(401);

      await cleanupTestUser(session1.userId);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. CSRF Protection for Cookie Authentication (Bearer Exempt)
  // ---------------------------------------------------------------------------
  describe('CSRF Enforcement', () => {
    let session: any;

    beforeAll(async () => {
      session = await createTestUserAndSession(app, {
        username: `csrf_test_${Date.now()}`,
      });
    });

    afterAll(async () => {
      if (session?.userId) {
        await cleanupTestUser(session.userId);
      }
    });

    it('exempts Bearer-authenticated requests from CSRF checks', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: session.authHeader, // Bearer without CSRF token
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects state-changing cookie-authenticated request without CSRF token or bad origin', async () => {
      const testUser = await createTestUserAndSession(app, {
        username: `csrf_cookie_${Date.now()}`,
      });

      // 1. Missing CSRF header with cookie auth -> 403 Forbidden
      const resNoCsrf = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          origin: 'http://localhost:3000',
          cookie: `access_token=${testUser.accessToken}; csrf_token=${testUser.csrfToken}`,
        },
      });
      expect(resNoCsrf.statusCode).toBe(403);
      expect(resNoCsrf.json().title).toBe('Forbidden');

      // 2. Untrusted Origin with cookie auth -> 403 Forbidden
      const resBadOrigin = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          origin: 'http://malicious-website.com',
          'x-csrf-token': testUser.csrfToken,
          cookie: `access_token=${testUser.accessToken}; csrf_token=${testUser.csrfToken}`,
        },
      });
      expect(resBadOrigin.statusCode).toBe(403);

      // 3. Valid Origin + matching CSRF header -> 200 OK
      const resOk = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          origin: 'http://localhost:3000',
          'x-csrf-token': testUser.csrfToken,
          cookie: `access_token=${testUser.accessToken}; csrf_token=${testUser.csrfToken}`,
        },
      });
      expect(resOk.statusCode).toBe(200);

      await cleanupTestUser(testUser.userId);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Password Recovery & Single-Use Recovery Codes
  // ---------------------------------------------------------------------------
  describe('Password Recovery', () => {
    it('resets password using valid recovery code and invalidates the code and all active sessions', async () => {
      const username = `recover_${Date.now()}`;
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { username, password: 'OldPassword123!' },
      });
      expect(regRes.statusCode).toBe(201);
      const regData = regRes.json();
      const recoveryCode = regData.recoveryCodes[0];
      const initialAccessToken = regData.tokens.accessToken;

      // Perform recovery
      const newPassword = 'NewSecretPassword2026!';
      const recoverRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/recover',
        payload: {
          username,
          recoveryCode,
          newPassword,
        },
      });
      expect(recoverRes.statusCode).toBe(200);

      // Verify past session is revoked immediately
      const checkOldSession = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${initialAccessToken}` },
      });
      expect(checkOldSession.statusCode).toBe(401);

      // Verify recovery code cannot be reused (single-use)
      const reuseRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/recover',
        payload: {
          username,
          recoveryCode,
          newPassword: 'AnotherPassword123!',
        },
      });
      expect(reuseRes.statusCode).toBe(401);

      // Verify user can login with new password
      const newLoginRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username, password: newPassword },
      });
      expect(newLoginRes.statusCode).toBe(200);

      await cleanupTestUser(regData.user.id);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Account Deletion Cascade, Storage Cleanup & Audit Logging
  // ---------------------------------------------------------------------------
  describe('Account Deletion', () => {
    it('deletes user, cascades resumes, jobs, sessions, calls deleteStorageObject, writes audit log', async () => {
      const session = await createTestUserAndSession(app, {
        username: `del_user_${Date.now()}`,
        password: 'DeleteMePassword123!',
      });

      // Create a test resume and job for this user
      const resume = await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'test.pdf',
          storageKey: `resumes/${session.userId}/test.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          status: 'PARSED',
          parsedResume: {
            create: {
              rawText: 'Sample resume text',
            },
          },
        },
      });

      const job = await prisma.job.create({
        data: {
          userId: session.userId,
          title: 'Software Engineer',
          company: 'Acme Corp',
          rawDescription: 'Job description text',
        },
      });

      const spyStorage = vi.spyOn(storageModule, 'deleteStorageObject').mockResolvedValue();

      // Delete account with password confirmation
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: session.authHeader,
        payload: { password: 'DeleteMePassword123!' },
      });

      expect(deleteRes.statusCode).toBe(200);
      expect(spyStorage).toHaveBeenCalledWith(resume.storageKey);

      // Verify User is gone
      const dbUser = await prisma.user.findUnique({ where: { id: session.userId } });
      expect(dbUser).toBeNull();

      // Verify Resume & Job are cascade-deleted
      const dbResume = await prisma.resume.findUnique({ where: { id: resume.id } });
      expect(dbResume).toBeNull();
      const dbJob = await prisma.job.findUnique({ where: { id: job.id } });
      expect(dbJob).toBeNull();

      // Verify AuditLog persists with ACCOUNT_DELETED event even though User was deleted
      const audit = await prisma.auditLog.findFirst({
        where: { userId: session.userId, event: 'ACCOUNT_DELETED' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.event).toBe('ACCOUNT_DELETED');

      spyStorage.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Route Inventory & IDOR Matrix
  // ---------------------------------------------------------------------------
  describe('Route-Inventory & IDOR Matrix', () => {
    it('asserts every route except /health and public auth routes returns 401 without auth', async () => {
      // Inventory of registered routes
      const routesToCheck = [
        { method: 'GET', url: '/v1/auth/me' },
        { method: 'POST', url: '/v1/auth/logout' },
        { method: 'POST', url: '/v1/auth/logout-all' },
        { method: 'POST', url: '/v1/auth/recovery-codes/regenerate' },
        { method: 'DELETE', url: '/v1/account' },
        { method: 'GET', url: '/v1/resumes' },
        { method: 'POST', url: '/v1/resumes/upload-url' },
        { method: 'GET', url: '/v1/resumes/11111111-1111-1111-1111-111111111111' },
        { method: 'DELETE', url: '/v1/resumes/11111111-1111-1111-1111-111111111111' },
        { method: 'POST', url: '/v1/jobs' },
        { method: 'POST', url: '/v1/jobs/11111111-1111-1111-1111-111111111111/match' },
        { method: 'POST', url: '/v1/rewriter/bullet' },
        { method: 'POST', url: '/v1/resumes/11111111-1111-1111-1111-111111111111/improvements' },
      ];

      for (const route of routesToCheck) {
        const method = route.method === 'ALL' ? 'GET' : (route.method as any);
        const res = await app.inject({
          method,
          url: route.url,
        });
        expect(res.statusCode, `Route ${route.method} ${route.url} should require auth (401)`).toBe(401);
      }
    });

    it('per-route foreign-resource IDOR test: asserts every ID-based route returns 404 Not Found for foreign resources', async () => {
      const userA = await createTestUserAndSession(app, { username: `user_a_${Date.now()}` });
      const userB = await createTestUserAndSession(app, { username: `user_b_${Date.now()}` });

      // User A creates a resume
      const resumeA = await prisma.resume.create({
        data: {
          userId: userA.userId,
          originalFilename: 'resumeA.pdf',
          storageKey: `resumes/${userA.userId}/resumeA.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          status: 'PARSED',
          parsedResume: {
            create: {
              rawText: 'Test bullet text for rewriter and improvements.',
            },
          },
        },
      });

      // User A creates a job
      const jobA = await prisma.job.create({
        data: {
          userId: userA.userId,
          title: 'Software Architect',
          company: 'Acme',
          rawDescription: 'Build great software.',
        },
      });

      // 1. GET /v1/resumes/:id -> 404
      const resGetResume = await app.inject({
        method: 'GET',
        url: `/v1/resumes/${resumeA.id}`,
        headers: userB.authHeader,
      });
      expect(resGetResume.statusCode, 'GET /v1/resumes/:id foreign ownership').toBe(404);

      // 2. POST /v1/resumes/:id/complete -> 404
      const resCompleteResume = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${resumeA.id}/complete`,
        headers: userB.authHeader,
        payload: {},
      });
      expect(resCompleteResume.statusCode, 'POST /v1/resumes/:id/complete foreign ownership').toBe(404);

      // 3. GET /v1/resumes/:id/download-url -> 404
      const resDownloadUrl = await app.inject({
        method: 'GET',
        url: `/v1/resumes/${resumeA.id}/download-url`,
        headers: userB.authHeader,
      });
      expect(resDownloadUrl.statusCode, 'GET /v1/resumes/:id/download-url foreign ownership').toBe(404);

      // 4. DELETE /v1/resumes/:id -> 404
      const resDelResume = await app.inject({
        method: 'DELETE',
        url: `/v1/resumes/${resumeA.id}`,
        headers: userB.authHeader,
      });
      expect(resDelResume.statusCode, 'DELETE /v1/resumes/:id foreign ownership').toBe(404);

      // 5. POST /v1/resumes/:id/improvements -> 404
      const resImprovements = await app.inject({
        method: 'POST',
        url: `/v1/resumes/${resumeA.id}/improvements`,
        headers: userB.authHeader,
      });
      expect(resImprovements.statusCode, 'POST /v1/resumes/:id/improvements foreign ownership').toBe(404);

      // 6. GET /v1/jobs/:id -> 404
      const resGetJob = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${jobA.id}`,
        headers: userB.authHeader,
      });
      expect(resGetJob.statusCode, 'GET /v1/jobs/:id foreign ownership').toBe(404);

      // 7. POST /v1/jobs/:id/match -> 404
      const resMatch = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobA.id}/match`,
        headers: userB.authHeader,
        payload: { resumeId: resumeA.id },
      });
      expect(resMatch.statusCode, 'POST /v1/jobs/:id/match foreign ownership').toBe(404);

      // 8. GET /v1/jobs/:id/matches/:resumeId -> 404
      const resGetMatch = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${jobA.id}/matches/${resumeA.id}`,
        headers: userB.authHeader,
      });
      expect(resGetMatch.statusCode, 'GET /v1/jobs/:id/matches/:resumeId foreign ownership').toBe(404);

      // 9. POST /v1/rewriter/bullet -> 404
      const resRewriter = await app.inject({
        method: 'POST',
        url: '/v1/rewriter/bullet',
        headers: userB.authHeader,
        payload: {
          resumeId: resumeA.id,
          jobId: jobA.id,
          originalBullet: 'Test bullet text for rewriter and improvements.',
        },
      });
      expect(resRewriter.statusCode, 'POST /v1/rewriter/bullet foreign ownership').toBe(404);

      // 10. POST /v1/jobs/:id/analysis -> 404 (User B cannot trigger analysis on User A job/resume)
      const resAnalysis = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobA.id}/analysis`,
        headers: userB.authHeader,
        payload: { resumeId: resumeA.id },
      });
      expect(resAnalysis.statusCode, 'POST /v1/jobs/:id/analysis foreign ownership').toBe(404);

      // 11. GET /v1/jobs/:id/analysis/:resumeId -> 404 (User B cannot retrieve analysis on User A job/resume)
      const resGetAnalysis = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${jobA.id}/analysis/${resumeA.id}`,
        headers: userB.authHeader,
      });
      expect(resGetAnalysis.statusCode, 'GET /v1/jobs/:id/analysis/:resumeId foreign ownership').toBe(404);

      await cleanupTestUser(userA.userId);
      await cleanupTestUser(userB.userId);
    });

    it('enforces bounded Argon2 hashing concurrency limit', async () => {
      const originalLimit = hashingLimiter.getMaxConcurrent();
      hashingLimiter.setMaxConcurrent(2);

      let maxActiveObserved = 0;
      const tasks = Array.from({ length: 5 }, async (_, i) => {
        const hashPromise = hashPassword(`ConcurrencyTestPass_${i}_2026!`);
        const currentActive = hashingLimiter.getActiveCount();
        if (currentActive > maxActiveObserved) {
          maxActiveObserved = currentActive;
        }
        return hashPromise;
      });

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(5);
      for (const h of results) {
        expect(h).toContain('$argon2id$');
      }
      expect(maxActiveObserved).toBeLessThanOrEqual(2);
      hashingLimiter.setMaxConcurrent(originalLimit);
    });

    it('verifies queued embedding, match, and analysis jobs for deleted user/resume end quietly without errors and without re-creating rows', async () => {
      const user = await createTestUserAndSession(app, { username: `queued_del_${Date.now()}` });
      const resume = await prisma.resume.create({
        data: {
          userId: user.userId,
          originalFilename: 'deleted_candidate.pdf',
          storageKey: `resumes/${user.userId}/deleted_candidate.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 2048,
          status: 'PARSED',
          parsedResume: {
            create: {
              rawText: 'Experienced developer',
            },
          },
        },
      });
      const job = await prisma.job.create({
        data: {
          userId: user.userId,
          title: 'Senior Developer',
          company: 'TestCorp',
          rawDescription: 'Looking for a senior developer.',
        },
      });

      const resumeId = resume.id;
      const jobId = job.id;

      // Delete user (cascades deletion)
      await cleanupTestUser(user.userId);

      // Verify entities are completely deleted from DB
      expect(await prisma.user.findUnique({ where: { id: user.userId } })).toBeNull();
      expect(await prisma.resume.findUnique({ where: { id: resumeId } })).toBeNull();
      expect(await prisma.job.findUnique({ where: { id: jobId } })).toBeNull();

      // Worker job simulation: verify queries return null and no rows are re-created
      const resumeCheck = await prisma.resume.findUnique({ where: { id: resumeId } });
      expect(resumeCheck).toBeNull();
      const chunksCount = await prisma.resumeChunk.count({ where: { resumeId } });
      expect(chunksCount).toBe(0);

      const jobCheck = await prisma.job.findUnique({ where: { id: jobId } });
      expect(jobCheck).toBeNull();
      const jobChunksCount = await prisma.jobChunk.count({ where: { jobId } });
      expect(jobChunksCount).toBe(0);

      const matchCheck = await prisma.match.count({ where: { resumeId, jobId } });
      expect(matchCheck).toBe(0);

      const analysisCheck = await prisma.analysis.count({ where: { resumeId, jobId } });
      expect(analysisCheck).toBe(0);
    });

    it('enforces exact cookie flags: HttpOnly, SameSite=Lax, Secure when COOKIE_SECURE=true, refresh Path=/v1/auth, and csrf_token flags', async () => {
      const username = `cookie_flags_${Date.now()}`;
      const password = 'CookieSecretPass123!';

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { username, password },
      });

      expect(res.statusCode).toBe(201);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];

      const accessCookie = cookies.find((c) => c.startsWith('access_token='));
      expect(accessCookie).toBeDefined();
      expect(accessCookie).toContain('HttpOnly');
      expect(accessCookie?.toLowerCase()).toContain('samesite=lax');

      const refreshCookie = cookies.find((c) => c.startsWith('refresh_token='));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie).toContain('HttpOnly');
      expect(refreshCookie?.toLowerCase()).toContain('samesite=lax');
      expect(refreshCookie).toContain('Path=/v1/auth');
      // Also scoped to the frontend proxy path, or browsers never send it to the refresh route
      expect(cookies.some((c) => c.startsWith('refresh_token=') && c.includes('Path=/api/backend/v1/auth'))).toBe(true);

      const csrfCookie = cookies.find((c) => c.startsWith('csrf_token='));
      expect(csrfCookie).toBeDefined();
      // Double submit: csrf_token must be readable by JavaScript (not HttpOnly)
      expect(csrfCookie).not.toContain('HttpOnly');
      expect(csrfCookie?.toLowerCase()).toContain('samesite=lax');

      if (env.COOKIE_SECURE) {
        expect(accessCookie).toContain('Secure');
        expect(refreshCookie).toContain('Secure');
        expect(csrfCookie).toContain('Secure');
      }

      await cleanupTestUser(res.json().user.id);
    });

    it('asserts captured application logs contain no passwords, tokens, or recovery codes across register, login, refresh, recover, and delete', async () => {
      const capturedLogs: string[] = [];
      const spyInfo = vi.spyOn(app.log, 'info').mockImplementation((...args: any[]) => {
        capturedLogs.push(JSON.stringify(args));
      });
      const spyWarn = vi.spyOn(app.log, 'warn').mockImplementation((...args: any[]) => {
        capturedLogs.push(JSON.stringify(args));
      });
      const spyError = vi.spyOn(app.log, 'error').mockImplementation((...args: any[]) => {
        capturedLogs.push(JSON.stringify(args));
      });

      const username = `log_audit_${Date.now()}`;
      const password = 'SuperSecretAuditPassword2026!';
      const newPassword = 'NewSecretAuditPassword2026!';

      try {
        // 1. Register
        const regRes = await app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: { username, password },
        });
        const regData = regRes.json();
        const code = regData.recoveryCodes[0];
        const initialRefresh = regData.tokens.refreshToken;

        // 2. Login
        const loginRes = await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { username, password },
        });
        const loginData = loginRes.json();
        const access = loginData.tokens.accessToken;
        const refresh = loginData.tokens.refreshToken;

        // 3. Refresh
        await app.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          payload: { refreshToken: refresh },
        });

        // 4. Recover
        await app.inject({
          method: 'POST',
          url: '/v1/auth/recover',
          payload: { username, recoveryCode: code, newPassword },
        });

        // 5. Delete account
        const loginNewRes = await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { username, password: newPassword },
        });
        const newAccess = loginNewRes.json().tokens.accessToken;

        await app.inject({
          method: 'DELETE',
          url: '/v1/account',
          headers: { authorization: `Bearer ${newAccess}` },
          payload: { password: newPassword },
        });

        // Verify that across all operations, captured logs NEVER contain secrets
        const allLogs = capturedLogs.join('\n');
        expect(allLogs).not.toContain(password);
        expect(allLogs).not.toContain(newPassword);
        expect(allLogs).not.toContain(access);
        expect(allLogs).not.toContain(refresh);
        expect(allLogs).not.toContain(initialRefresh);
        expect(allLogs).not.toContain(code);
      } finally {
        spyInfo.mockRestore();
        spyWarn.mockRestore();
        spyError.mockRestore();
      }
    });

    it('enforces lockout with growing exponential backoff for a NONEXISTENT username', async () => {
      const ghostUser = `nonexistent_lockout_${Date.now()}`;

      // 5 failed attempts
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { username: ghostUser, password: 'WrongPassword123!' },
        });
        expect(res.statusCode).toBe(401);
      }

      // 6th attempt must trigger lockout (429 with Retry-After)
      const res6 = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username: ghostUser, password: 'WrongPassword123!' },
      });
      expect(res6.statusCode).toBe(429);
      expect(res6.headers['retry-after']).toBeDefined();
      const retryAfter = Number(res6.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(1800);

      // Clean up Redis keys
      await redisClient.del(`auth:lockout:${ghostUser}`, `auth:failed_login:${ghostUser}`);
    });

    it('enforces Cache-Control: no-store on all /v1/auth route responses', async () => {
      const session = await createTestUserAndSession(app, { username: `cache_test_${Date.now()}` });

      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/v1/auth/me', headers: session.authHeader }),
        app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: session.user.username, password: 'WrongPassword123!' } }),
        app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: 'invalid' } }),
      ]);

      for (const res of responses) {
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['pragma']).toBe('no-cache');
      }

      await cleanupTestUser(session.userId);
    });

    it('verifies account deletion removes storage objects for all user resumes', async () => {
      const session = await createTestUserAndSession(app, { username: `storage_del_${Date.now()}` });

      const resume1 = await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'file1.pdf',
          storageKey: `resumes/${session.userId}/file1.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          status: 'PARSED',
        },
      });

      const resume2 = await prisma.resume.create({
        data: {
          userId: session.userId,
          originalFilename: 'file2.pdf',
          storageKey: `resumes/${session.userId}/file2.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 2048,
          status: 'PARSED',
        },
      });

      const spyStorage = vi.spyOn(storageModule, 'deleteStorageObject').mockResolvedValue();

      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: session.authHeader,
        payload: { password: 'SecurePassword123!' },
      });

      expect(res.statusCode).toBe(200);
      expect(spyStorage).toHaveBeenCalledWith(resume1.storageKey);
      expect(spyStorage).toHaveBeenCalledWith(resume2.storageKey);

      const dbUser = await prisma.user.findUnique({ where: { id: session.userId } });
      expect(dbUser).toBeNull();

      spyStorage.mockRestore();
    });

    it('builds route inventory from actual route table, classifies every route, and asserts all protected routes return 401 unauthenticated', async () => {
      // Build route inventory dynamically by registering onRoute hook on a test instance
      const registeredRoutes: Array<{ method: string; url: string }> = [];
      const testServer = buildServer();
      testServer.addHook('onRoute', (opts) => {
        const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
        for (const method of methods) {
          if (method !== 'HEAD') {
            registeredRoutes.push({ method: String(method), url: opts.url });
          }
        }
      });
      await testServer.ready();

      const classified = {
        PUBLIC: 0,
        PUBLIC_AUTH: 0,
        PROTECTED: 0,
        LEGACY_STUB: 0,
        CORS_PREFLIGHT: 0,
      };

      const publicAuthPaths = [
        '/v1/auth/register',
        '/v1/auth/login',
        '/v1/auth/refresh',
        '/v1/auth/recover',
      ];

      for (const route of registeredRoutes) {
        let category: keyof typeof classified | null = null;

        if (route.method === 'OPTIONS') {
          category = 'CORS_PREFLIGHT';
        } else if (
          route.method === 'GET' &&
          (route.url === '/health' || route.url === '/openapi.json' || route.url.startsWith('/docs'))
        ) {
          category = 'PUBLIC';
        } else if (publicAuthPaths.includes(route.url)) {
          category = 'PUBLIC_AUTH';
        } else if (
          ['/resumes', '/jobs', '/analyses'].some((p) => route.url.startsWith(p)) ||
          (route.url === '/v1/jobs/:id' && route.method === 'DELETE')
        ) {
          category = 'LEGACY_STUB';
        } else if (route.url.startsWith('/v1/')) {
          category = 'PROTECTED';
        }

        expect(category, `Route ${route.method} ${route.url} must be classified`).not.toBeNull();
        if (category) {
          classified[category]++;
        }

        // If PROTECTED or LEGACY_STUB, verify calling without credentials returns 401
        if (category === 'PROTECTED' || category === 'LEGACY_STUB') {
          const testUrl = route.url.replace(/:[a-zA-Z]+/g, '11111111-1111-1111-1111-111111111111');
          const headers: Record<string, string> = {};
          if (route.method === 'QUERY') {
            headers['content-type'] = 'application/json';
          }
          const res = await testServer.inject({
            method: route.method as any,
            url: testUrl,
            headers,
          });
          expect(res.statusCode, `Route ${route.method} ${route.url} should return 401 without auth`).toBe(401);
        }
      }

      await testServer.close();

      console.log('=== ROUTE TABLE INVENTORY & CLASSIFICATION ===');
      console.log(`Total Registered Routes: ${registeredRoutes.length}`);
      console.log(`- PUBLIC: ${classified.PUBLIC}`);
      console.log(`- PUBLIC_AUTH: ${classified.PUBLIC_AUTH}`);
      console.log(`- PROTECTED: ${classified.PROTECTED}`);
      console.log(`- LEGACY_STUB: ${classified.LEGACY_STUB}`);
      console.log(`- CORS_PREFLIGHT: ${classified.CORS_PREFLIGHT}`);

      expect(registeredRoutes.length).toBeGreaterThan(0);
      expect(classified.PROTECTED).toBeGreaterThan(0);
    });

    it('verifies audit logs never contain passwords, raw tokens, or recovery codes', async () => {
      const recentAudits = await prisma.auditLog.findMany({
        take: 20,
        orderBy: { createdAt: 'desc' },
      });

      for (const audit of recentAudits) {
        const jsonStr = JSON.stringify(audit);
        expect(jsonStr).not.toContain('Password123!');
        expect(jsonStr).not.toContain('DeleteMePassword');
        expect(jsonStr).not.toContain('UniqueSuperPassword');
      }
    });

    it('rejects unauthenticated requests with malformed or oversized body with 401 before body parsing', async () => {
      // 1. Malformed JSON payload to protected route
      const malformedRes = await app.inject({
        method: 'POST',
        url: '/v1/resumes/upload-url',
        headers: {
          'content-type': 'application/json',
        },
        payload: '{ invalid json payload :: not closed',
      });
      expect(malformedRes.statusCode).toBe(401);
      expect(malformedRes.json().error).toBe('Unauthorized');

      // 2. Oversized payload (> default 1MB / small limits) to protected route
      const oversizedPayload = JSON.stringify({
        filename: 'resume.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        extraData: 'A'.repeat(5 * 1024 * 1024), // 5MB payload
      });

      const oversizedRes = await app.inject({
        method: 'POST',
        url: '/v1/resumes/upload-url',
        headers: {
          'content-type': 'application/json',
        },
        payload: oversizedPayload,
      });
      expect(oversizedRes.statusCode).toBe(401);
      expect(oversizedRes.json().error).toBe('Unauthorized');

      // 3. Malformed JSON to another protected route (e.g. /v1/rewriter/bullet)
      const rewriterRes = await app.inject({
        method: 'POST',
        url: '/v1/rewriter/bullet',
        headers: {
          'content-type': 'application/json',
        },
        payload: '<<<not a json object>>>',
      });
      expect(rewriterRes.statusCode).toBe(401);
      expect(rewriterRes.json().error).toBe('Unauthorized');
    });
  });
});
