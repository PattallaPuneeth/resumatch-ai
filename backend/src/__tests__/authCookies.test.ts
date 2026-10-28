import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { clearAuthCookies, REFRESH_COOKIE_PATHS, setAuthCookies } from '../auth/tokens.js';

/** Builds a bare app with the cookie plugin, so these checks need no database. */
async function buildApp() {
  const app = Fastify();
  await app.register(cookie);
  app.get('/set', async (_req, reply) => {
    setAuthCookies(reply, { accessToken: 'a', refreshToken: 'r', csrfToken: 'c' });
    return { ok: true };
  });
  app.get('/clear', async (_req, reply) => {
    clearAuthCookies(reply);
    return { ok: true };
  });
  return app;
}

function setCookies(header: string | string[] | undefined): string[] {
  return Array.isArray(header) ? header : header ? [header] : [];
}

describe('auth cookies', () => {
  it('scopes the refresh cookie to both the direct and the proxied auth path', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/set' });
    const refresh = setCookies(res.headers['set-cookie']).filter((c) => c.startsWith('refresh_token=r'));

    expect(REFRESH_COOKIE_PATHS).toContain('/api/backend/v1/auth');
    for (const path of REFRESH_COOKIE_PATHS) {
      expect(refresh.some((c) => c.includes(`Path=${path};`) || c.endsWith(`Path=${path}`))).toBe(true);
    }
    expect(refresh.every((c) => c.includes('HttpOnly'))).toBe(true);
    await app.close();
  });

  it('clears the refresh cookie on every path it was set on', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/clear' });
    const cleared = setCookies(res.headers['set-cookie']).filter((c) => c.startsWith('refresh_token=;'));

    expect(cleared).toHaveLength(REFRESH_COOKIE_PATHS.length);
    await app.close();
  });
});
