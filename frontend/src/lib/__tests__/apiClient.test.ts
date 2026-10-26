import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  apiClient,
  apiClientRequest,
  ApiProblemError,
  getCsrfTokenFromCookie,
} from '../apiClient';

describe('Production API Client (src/lib/apiClient.ts)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Clear cookies
    if (typeof document !== 'undefined') {
      document.cookie = 'csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CSRF Header Enforcement', () => {
    it('extracts csrf_token from document.cookie', () => {
      document.cookie = 'csrf_token=test-csrf-secret-12345; path=/';
      expect(getCsrfTokenFromCookie()).toBe('test-csrf-secret-12345');
    });

    it('attaches x-csrf-token header on mutating requests (POST, PUT, DELETE, PATCH)', async () => {
      document.cookie = 'csrf_token=my-csrf-token-99; path=/';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
        headers: new Headers(),
      });
      global.fetch = fetchMock;

      await apiClientRequest('/v1/resumes/upload-url', {
        method: 'POST',
        body: JSON.stringify({ filename: 'test.pdf' }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledOptions = fetchMock.mock.calls[0][1];
      expect(calledOptions.headers['x-csrf-token']).toBe('my-csrf-token-99');
      expect(calledOptions.credentials).toBe('include');
    });

    it('does NOT attach x-csrf-token on GET requests', async () => {
      document.cookie = 'csrf_token=my-csrf-token-99; path=/';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ resumes: [] }),
        headers: new Headers(),
      });
      global.fetch = fetchMock;

      await apiClientRequest('/v1/resumes', { method: 'GET' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledOptions = fetchMock.mock.calls[0][1];
      expect(calledOptions.headers['x-csrf-token']).toBeUndefined();
    });
  });

  describe('RFC 7807 Problem Details Parsing', () => {
    it('parses standard RFC 7807 error responses into ApiProblemError', async () => {
      const problem = {
        type: 'https://httpstatuses.com/400',
        title: 'Bad Request',
        status: 400,
        detail: 'Validation failed: username is required',
        instance: '/v1/auth/register',
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers(),
        json: async () => problem,
      });

      try {
        await apiClientRequest('/v1/auth/register', { method: 'POST', body: '{}' });
        expect.unreachable('Should have thrown ApiProblemError');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiProblemError);
        const apiErr = err as ApiProblemError;
        expect(apiErr.status).toBe(400);
        expect(apiErr.title).toBe('Bad Request');
        expect(apiErr.detail).toBe('Validation failed: username is required');
        expect(apiErr.instance).toBe('/v1/auth/register');
      }
    });

    it('parses 429 usage limit error with meter, used, limit, resetAt', async () => {
      const usageProblem = {
        type: 'https://api.resumatch.ai/errors/usage-limit-exceeded',
        title: 'Usage Limit Exceeded',
        status: 429,
        detail: 'Usage limit reached for meter "resume_storage_bytes". Current usage: 5242880/5242880.',
        meter: 'resume_storage_bytes',
        used: 5242880,
        limit: 5242880,
        resetAt: null,
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '60' }),
        json: async () => usageProblem,
      });

      try {
        await apiClient.resumes.requestUploadUrl({
          filename: 'cv.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1000,
        });
        expect.unreachable('Should have thrown ApiProblemError');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiProblemError);
        const apiErr = err as ApiProblemError;
        expect(apiErr.status).toBe(429);
        expect(apiErr.meter).toBe('resume_storage_bytes');
        expect(apiErr.used).toBe(5242880);
        expect(apiErr.limit).toBe(5242880);
        expect(apiErr.retryAfter).toBe(60);
      }
    });
  });

  describe('Single-Flight Automatic Refresh on 401', () => {
    it('executes a single refresh call when 401 is encountered and retries original request', async () => {
      let callCount = 0;
      let refreshCount = 0;

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/auth/refresh')) {
          refreshCount++;
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ message: 'Refreshed' }),
          };
        }

        callCount++;
        if (callCount === 1) {
          // First attempt fails with 401
          return {
            ok: false,
            status: 401,
            headers: new Headers(),
            json: async () => ({ title: 'Unauthorized', detail: 'Token expired' }),
          };
        }

        // Retry succeeds
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ resumes: [{ id: 'res-1' }] }),
        };
      });

      const res = await apiClient.resumes.list();
      expect(res.resumes).toHaveLength(1);
      expect(refreshCount).toBe(1);
      expect(callCount).toBe(2);
    });

    it('coalesces multiple concurrent 401 requests into exactly one single-flight refresh call', async () => {
      let refreshCalls = 0;
      let resumeCalls = 0;
      let usageCalls = 0;

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/auth/refresh')) {
          refreshCalls++;
          // simulate slight network delay
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ message: 'Refreshed' }),
          };
        }

        if (url.includes('/v1/resumes')) {
          resumeCalls++;
          if (resumeCalls === 1) {
            return {
              ok: false,
              status: 401,
              headers: new Headers(),
              json: async () => ({ title: 'Unauthorized' }),
            };
          }
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ resumes: [] }),
          };
        }

        if (url.includes('/v1/usage')) {
          usageCalls++;
          if (usageCalls === 1) {
            return {
              ok: false,
              status: 401,
              headers: new Headers(),
              json: async () => ({ title: 'Unauthorized' }),
            };
          }
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ plan: 'unlimited' }),
          };
        }

        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({}),
        };
      });

      // Fire both in parallel while unauthenticated
      const [resumesRes, usageRes] = await Promise.all([
        apiClient.resumes.list(),
        apiClient.usage.get(),
      ]);

      expect(resumesRes).toBeDefined();
      expect(usageRes).toBeDefined();
      expect(refreshCalls).toBe(1); // Crucial: exactly 1 refresh call for both parallel requests
    });
  });

  describe('Timeout Handling', () => {
    it('throws ApiProblemError 408 on timeout', async () => {
      global.fetch = vi.fn().mockImplementation((_url, options) => {
        return new Promise((_resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          }
        });
      });

      await expect(
        apiClientRequest('/v1/resumes', { timeoutMs: 50 })
      ).rejects.toMatchObject({
        status: 408,
        title: 'Request Timeout',
      });
    });
  });
});
