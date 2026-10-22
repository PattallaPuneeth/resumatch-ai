import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

/**
 * Dual Node S3 Clients (Section 4.3):
 * 1. s3InternalClient: communicates directly with the storage backend
 *    (e.g., http://minio:9000 inside Docker or Cloudflare R2 endpoint in prod).
 * 2. s3SignerClient: signs browser-facing presigned URLs using the public endpoint
 *    (e.g., http://localhost:9000 reachable by local browser) with forcePathStyle: true.
 */
export const s3InternalClient = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

export const s3SignerClient = new S3Client({
  endpoint: env.S3_PUBLIC_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

export interface PresignedUploadResult {
  uploadUrl: string;
  headers: Record<string, string>;
  expiresIn: number;
}

export interface PresignedDownloadResult {
  downloadUrl: string;
  expiresIn: number;
}

/**
 * Generate standard storage key according to Section 4.4:
 * Format: resumes/{userId}/{resumeId}.{pdf|docx}
 */
export function buildStorageKey(userId: string, resumeId: string, ext: 'pdf' | 'docx'): string {
  const cleanExt = ext.toLowerCase().replace(/^\./, '');
  return `resumes/${userId}/${resumeId}.${cleanExt}`;
}

/**
 * Generate a short-lived presigned PUT URL for direct browser-to-S3 upload.
 */
export async function createPresignedUploadUrl(params: {
  storageKey: string;
  mimeType: string;
  expiresInSeconds?: number;
}): Promise<PresignedUploadResult> {
  const expiresIn = params.expiresInSeconds ?? env.PRESIGN_PUT_TTL_SECONDS;

  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: params.storageKey,
    ContentType: params.mimeType,
  });

  const uploadUrl = await getSignedUrl(s3SignerClient, command, { expiresIn });

  return {
    uploadUrl,
    headers: {
      'Content-Type': params.mimeType,
    },
    expiresIn,
  };
}

/**
 * Generate a short-lived presigned GET URL for secure direct browser download.
 */
export async function createPresignedDownloadUrl(params: {
  storageKey: string;
  originalFilename?: string;
  expiresInSeconds?: number;
}): Promise<PresignedDownloadResult> {
  const expiresIn = params.expiresInSeconds ?? env.PRESIGN_GET_TTL_SECONDS;

  const contentDisposition = params.originalFilename
    ? `attachment; filename="${encodeURIComponent(params.originalFilename)}"`
    : 'attachment';

  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: params.storageKey,
    ResponseContentDisposition: contentDisposition,
  });

  const downloadUrl = await getSignedUrl(s3SignerClient, command, { expiresIn });

  return {
    downloadUrl,
    expiresIn,
  };
}

/**
 * Inspect object metadata and confirm existence using s3InternalClient.
 */
export async function headStorageObject(storageKey: string): Promise<{
  contentLength: number;
  contentType?: string;
  etag?: string;
} | null> {
  try {
    const command = new HeadObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: storageKey,
    });
    const res = await s3InternalClient.send(command);
    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType,
      etag: res.ETag,
    };
  } catch (err: any) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
      return null;
    }
    throw err;
  }
}

/**
 * Read a small byte range to validate magic bytes (e.g., %PDF- or PK..)
 */
export async function getStorageObjectByteRange(
  storageKey: string,
  start: number,
  end: number
): Promise<Buffer> {
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: storageKey,
    Range: `bytes=${start}-${end}`,
  });

  const response = await s3InternalClient.send(command);
  if (!response.Body) {
    throw new Error('S3 object body is empty');
  }

  const byteArray = await response.Body.transformToByteArray();
  return Buffer.from(byteArray);
}

/**
 * Delete an object from storage using s3InternalClient.
 */
export async function deleteStorageObject(storageKey: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: storageKey,
  });
  await s3InternalClient.send(command);
}

/**
 * Check S3 connection and bucket availability for health endpoints.
 */
export async function checkS3Health(): Promise<{
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const command = new HeadBucketCommand({
      Bucket: env.S3_BUCKET,
    });
    await s3InternalClient.send(command);
    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'S3 connection failed',
    };
  }
}
