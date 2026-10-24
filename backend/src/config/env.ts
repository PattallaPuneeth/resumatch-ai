import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env file from project root or current working directory
dotenv.config();

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // PostgreSQL + pgvector
  DATABASE_URL: z.string().url().default('postgresql://resumatch_user:resumatch_password@localhost:5432/resumatch?schema=public'),

  // Redis & BullMQ
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_URL: z.string().optional(),

  // MinIO S3 (Legacy compatibility)
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') return val.toLowerCase() === 'true';
      return false;
    })
    .default(false),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),
  MINIO_BUCKET_NAME: z.string().default('resumes'),

  // S3-Compatible Object Storage (Phase 2A)
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_PUBLIC_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('resumes'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_FORCE_PATH_STYLE: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') return val.toLowerCase() === 'true';
      return true;
    })
    .default(true),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5242880),
  PRESIGN_PUT_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  PRESIGN_GET_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Auth
  JWT_SECRET: z.string().min(16).default('local-dev-secret-change-in-production'),

  // Per-user resume upload cap
  RESUME_CAP_PER_USER: z.coerce.number().int().positive().default(50),

  // Python ML Service
  ML_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(384),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(overrideEnv?: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(overrideEnv ?? process.env);
  if (!result.success) {
    const formattedErrors = result.error.format();
    console.error('❌ Environment validation failed:', JSON.stringify(formattedErrors, null, 2));
    throw new Error('Environment configuration error');
  }
  return result.data;
}

export const env: Env = loadEnv();
