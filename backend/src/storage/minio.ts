import * as Minio from 'minio';
import { env } from '../config/env.js';

export const minioClient = new Minio.Client({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
});

export async function checkMinioHealth(): Promise<{ status: 'healthy' | 'unhealthy'; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const exists = await minioClient.bucketExists(env.MINIO_BUCKET_NAME);
    if (!exists) {
      return {
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        error: `MinIO bucket "${env.MINIO_BUCKET_NAME}" does not exist`,
      };
    }
    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'MinIO connection failed',
    };
  }
}
