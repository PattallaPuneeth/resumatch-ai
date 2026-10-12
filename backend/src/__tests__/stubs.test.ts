import { describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

describe('Route Stubs (Phase 1)', () => {
  const app = buildServer();

  it('GET /resumes should return 501 Not Implemented', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/resumes',
    });

    expect(response.statusCode).toBe(501);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      statusCode: 501,
      error: 'Not Implemented',
    });
  });

  it('POST /resumes should return 501 Not Implemented', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/resumes',
      payload: { dummy: 'test' },
    });

    expect(response.statusCode).toBe(501);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Not Implemented');
  });

  it('GET /analyses should return 501 Not Implemented', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/analyses',
    });

    expect(response.statusCode).toBe(501);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Not Implemented');
  });

  it('POST /analyses should return 501 Not Implemented', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/analyses',
      payload: { resumeId: 'abc' },
    });

    expect(response.statusCode).toBe(501);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Not Implemented');
  });

  it('GET /jobs should return 501 Not Implemented', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/jobs',
    });

    expect(response.statusCode).toBe(501);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Not Implemented');
  });

  it('POST /jobs should return 501 Not Implemented', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { title: 'Engineer' },
    });

    expect(response.statusCode).toBe(501);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Not Implemented');
  });
});
