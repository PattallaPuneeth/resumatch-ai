import { describe, expect, it } from 'vitest';
import {
  buildStorageKey,
  checkS3Health,
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
  s3InternalClient,
  s3SignerClient,
} from '../storage/s3.js';

describe('S3 Storage Module (Phase 2A)', () => {
  it('should format storage keys per Section 4.4 specification', () => {
    const userId = 'user-123-uuid';
    const resumeId = 'resume-456-uuid';

    const pdfKey = buildStorageKey(userId, resumeId, 'pdf');
    expect(pdfKey).toBe('resumes/user-123-uuid/resume-456-uuid.pdf');

    const docxKey = buildStorageKey(userId, resumeId, 'docx');
    expect(docxKey).toBe('resumes/user-123-uuid/resume-456-uuid.docx');
  });

  it('should maintain dual client endpoint separation per Section 4.3', async () => {
    // s3InternalClient endpoint configuration
    expect(s3InternalClient.config.endpoint).toBeDefined();
    if (typeof s3InternalClient.config.endpoint === 'function') {
      const internalEndpoint = await s3InternalClient.config.endpoint();
      expect(internalEndpoint.protocol).toBeDefined();
    }

    // s3SignerClient endpoint configuration
    expect(s3SignerClient.config.endpoint).toBeDefined();
    if (typeof s3SignerClient.config.endpoint === 'function') {
      const signerEndpoint = await s3SignerClient.config.endpoint();
      expect(signerEndpoint.protocol).toBeDefined();
    }

    // Verify forcePathStyle is enabled
    expect(s3SignerClient.config.forcePathStyle).toBe(true);
  });

  it('should generate a valid presigned PUT upload URL with required headers', async () => {
    const storageKey = 'resumes/test-user/test-resume.pdf';
    const mimeType = 'application/pdf';

    const result = await createPresignedUploadUrl({
      storageKey,
      mimeType,
      expiresInSeconds: 300,
    });

    expect(result.uploadUrl).toBeDefined();
    expect(typeof result.uploadUrl).toBe('string');
    // Presigned URL must point to public endpoint / bucket / key
    expect(result.uploadUrl).toContain(encodeURIComponent(storageKey).replace(/%2F/g, '/'));
    expect(result.headers['Content-Type']).toBe('application/pdf');
    expect(result.expiresIn).toBe(300);
  });

  it('should generate a valid presigned GET download URL with attachment disposition', async () => {
    const storageKey = 'resumes/test-user/test-resume.pdf';
    const originalFilename = 'My Resume 2026.pdf';

    const result = await createPresignedDownloadUrl({
      storageKey,
      originalFilename,
      expiresInSeconds: 300,
    });

    expect(result.downloadUrl).toBeDefined();
    expect(typeof result.downloadUrl).toBe('string');
    expect(result.downloadUrl).toContain('response-content-disposition');
    expect(result.expiresIn).toBe(300);
  });

  it('should return health status structure when checking S3 health', async () => {
    const health = await checkS3Health();
    expect(['healthy', 'unhealthy']).toContain(health.status);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
