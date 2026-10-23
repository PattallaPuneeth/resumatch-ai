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
  it('requestUploadUrl sends POST with auth token and returns presigned URL data', async () => {
    const mockResponse = {
      resumeId: '123e4567-e89b-12d3-a456-426614174000',
      uploadUrl: 'http://localhost:9000/resumes/user/123.pdf?sig=abc',
      headers: { 'Content-Type': 'application/pdf' },
      expiresIn: 300,
      storageKey: 'resumes/user/123.pdf',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    const result = await api.requestUploadUrl(
      { filename: 'cv.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
      'test-token'
    );

    expect(result.resumeId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(result.uploadUrl).toContain('localhost:9000');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/resumes/upload-url'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      })
    );
  });

  it('completeUpload sends POST with auth token and returns 202 status', async () => {
    const mockResponse = {
      resumeId: '123e4567-e89b-12d3-a456-426614174000',
      status: 'UPLOADED',
      message: 'Resume accepted for processing.',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    const result = await api.completeUpload('123e4567-e89b-12d3-a456-426614174000', 'test-token');

    expect(result.status).toBe('UPLOADED');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/resumes/123e4567-e89b-12d3-a456-426614174000/complete'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      })
    );
  });

  it('uploadToStorage performs PUT request via XMLHttpRequest and tracks progress', async () => {
    const mockXHR = {
      open: vi.fn(),
      send: vi.fn(),
      setRequestHeader: vi.fn(),
      upload: {
        addEventListener: vi.fn(),
      },
      addEventListener: vi.fn((event, callback) => {
        if (event === 'load') {
          setTimeout(() => {
            mockXHR.status = 200;
            callback();
          }, 0);
        }
      }),
      status: 200,
      timeout: 0,
    };

    vi.stubGlobal(
      'XMLHttpRequest',
      vi.fn(() => mockXHR)
    );

    const file = new File(['%PDF-1.4 test'], 'cv.pdf', { type: 'application/pdf' });
    const progressSpy = vi.fn();

    await api.uploadToStorage(
      'http://localhost:9000/resumes/user/123.pdf?sig=abc',
      file,
      { 'Content-Type': 'application/pdf' },
      progressSpy
    );

    expect(mockXHR.open).toHaveBeenCalledWith('PUT', 'http://localhost:9000/resumes/user/123.pdf?sig=abc');
    expect(mockXHR.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(mockXHR.send).toHaveBeenCalledWith(file);
  });
});

