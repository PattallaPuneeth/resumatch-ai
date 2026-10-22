import { describe, expect, it, vi, beforeEach } from 'vitest';
import { api, ApiException } from './api';

describe('Frontend API Client (src/lib/api.ts)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getBackendHealth should parse successful 200 JSON', async () => {
    const mockHealth = {
      status: 'healthy',
      timestamp: '2026-10-12T00:00:00Z',
      version: '1.0.0',
      services: {
        postgres: { status: 'healthy', latencyMs: 2 },
        redis: { status: 'healthy', latencyMs: 1 },
        minio: { status: 'healthy', latencyMs: 3 },
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockHealth,
    } as unknown as Response);

    const result = await api.getBackendHealth();
    expect(result.status).toBe('healthy');
    expect(result.services.postgres.status).toBe('healthy');
  });

  it('getResumes should throw ApiException on 501 Not Implemented', async () => {
    const mock501 = {
      statusCode: 501,
      error: 'Not Implemented',
      message: 'Resume management endpoint is not yet implemented. Available in Phase 2.',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 501,
      statusText: 'Not Implemented',
      json: async () => mock501,
    } as unknown as Response);

    await expect(api.getResumes()).rejects.toThrow(ApiException);
    try {
      await api.getResumes();
    } catch (err) {
      const apiErr = err as ApiException;
      expect(apiErr.statusCode).toBe(501);
      expect(apiErr.errorName).toBe('Not Implemented');
    }
  });
});
