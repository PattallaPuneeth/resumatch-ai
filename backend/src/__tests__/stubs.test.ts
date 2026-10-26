import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../server.js';
import { createTestUserAndSession, cleanupTestUser, type TestAuthSession } from './testAuthHelper.js';

describe('Route Stubs (Default-Deny & Legacy 501)', () => {
  const app = buildServer();
  let session: TestAuthSession;

  beforeAll(async () => {
    await app.ready();
    session = await createTestUserAndSession(app, { username: `stub_tester_${Date.now()}` });
  });

  afterAll(async () => {
    if (session?.userId) {
      await cleanupTestUser(session.userId);
    }
    await app.close();
  });

  describe('Unauthenticated stub calls return 401 (Default-Deny)', () => {
    it('GET /resumes without auth returns 401 Unauthorized', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/resumes',
      });
      expect(response.statusCode).toBe(401);
    });

    it('POST /resumes without auth returns 401 Unauthorized', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/resumes',
        payload: { dummy: 'test' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('GET /analyses without auth returns 401 Unauthorized', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/analyses',
      });
      expect(response.statusCode).toBe(401);
    });

    it('POST /analyses without auth returns 401 Unauthorized', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/analyses',
        payload: { resumeId: 'abc' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('GET /jobs without auth returns 401 Unauthorized', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/jobs',
      });
      expect(response.statusCode).toBe(401);
    });

    it('POST /jobs without auth returns 401 Unauthorized', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/jobs',
        payload: { title: 'Engineer' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('Authenticated stub calls return 501 Not Implemented', () => {
    it('GET /resumes with auth returns 501 Not Implemented', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/resumes',
        headers: session.authHeader,
      });

      expect(response.statusCode).toBe(501);
      const body = JSON.parse(response.body);
      expect(body).toMatchObject({
        statusCode: 501,
        error: 'Not Implemented',
      });
    });

    it('POST /resumes with auth returns 501 Not Implemented', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/resumes',
        headers: session.authHeader,
        payload: { dummy: 'test' },
      });

      expect(response.statusCode).toBe(501);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not Implemented');
    });

    it('GET /analyses with auth returns 501 Not Implemented', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/analyses',
        headers: session.authHeader,
      });

      expect(response.statusCode).toBe(501);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not Implemented');
    });

    it('POST /analyses with auth returns 501 Not Implemented', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/analyses',
        headers: session.authHeader,
        payload: { resumeId: 'abc' },
      });

      expect(response.statusCode).toBe(501);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not Implemented');
    });

    it('GET /jobs with auth returns 501 Not Implemented', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/jobs',
        headers: session.authHeader,
      });

      expect(response.statusCode).toBe(501);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not Implemented');
    });

    it('POST /jobs with auth returns 501 Not Implemented', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/jobs',
        headers: session.authHeader,
        payload: { title: 'Engineer' },
      });

      expect(response.statusCode).toBe(501);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not Implemented');
    });
  });
});
