import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Load .env file from project root and current working directory
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

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

  // Auth (Phase 5)
  JWT_SECRET: z
    .string({
      required_error: 'JWT_SECRET is required and must be at least 32 characters',
    })
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .refine(
      (val) => {
        const lower = val.toLowerCase();
        return !lower.includes('local-dev') && !lower.includes('change');
      },
      {
        message: 'JWT_SECRET must not contain "local-dev" or "change"',
      }
    ),
  COOKIE_SECURE: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') return val.toLowerCase() === 'true';
      return false;
    })
    .default(false),
  TRUST_PROXY: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') return val.toLowerCase() === 'true';
      return false;
    })
    .default(false),
  CORS_ORIGIN: z.string().default('http://localhost:3000,http://127.0.0.1:3000'),

  // Per-user resume upload cap
  RESUME_CAP_PER_USER: z.coerce.number().int().positive().default(50),

  // Python ML Service
  ML_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  INTERNAL_API_TOKEN: z
    .string({
      required_error: 'INTERNAL_API_TOKEN is required and must be at least 32 characters',
    })
    .min(32, 'INTERNAL_API_TOKEN must be at least 32 characters')
    .refine((val) => !val.toLowerCase().includes('change_me'), {
      message: 'INTERNAL_API_TOKEN cannot contain CHANGE_ME placeholder',
    }),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(384),

  // Usage & Metering (Phase 6)
  USAGE_DEFAULT_PLAN: z.string().default('unlimited'),

  // Job Suggestions & Scraping (Phase 7)
  FIRECRAWL_API_KEY: z.string().optional(),
  JOB_SOURCE_ALLOWLIST: z.string().default('boards.greenhouse.io,jobs.lever.co,jobs.ashbyhq.com'),
  JOB_SOURCE_MAX_QUERIES: z.coerce.number().int().positive().default(1),

  // Production Boot Guard Controls (Phase 9 - C5)
  ALLOW_DEV_DEFAULTS: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') return val.toLowerCase() === 'true';
      return false;
    })
    .default(false),
  ENFORCE_PRODUCTION_BOOT_GUARD: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') return val.toLowerCase() === 'true';
      return false;
    })
    .default(false),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateProductionBootGuard(
  envData: Env,
  options?: { enforceStrict?: boolean }
): { valid: boolean; errors: string[] } {
  const shouldEnforce =
    options?.enforceStrict ||
    envData.ENFORCE_PRODUCTION_BOOT_GUARD ||
    (envData.NODE_ENV === 'production' && !envData.ALLOW_DEV_DEFAULTS);

  if (!shouldEnforce) {
    return { valid: true, errors: [] };
  }

  const errors: string[] = [];

  if (envData.DATABASE_URL.includes('resumatch_password')) {
    errors.push('DATABASE_URL contains default password "resumatch_password"');
  }

  if (envData.S3_ACCESS_KEY === 'minioadmin' || envData.S3_SECRET_KEY === 'minioadmin') {
    errors.push('S3 credentials use default "minioadmin"');
  }

  if (envData.MINIO_ACCESS_KEY === 'minioadmin' || envData.MINIO_SECRET_KEY === 'minioadmin') {
    errors.push('MINIO credentials use default "minioadmin"');
  }

  if (
    !envData.INTERNAL_API_TOKEN ||
    envData.INTERNAL_API_TOKEN.length < 32 ||
    envData.INTERNAL_API_TOKEN.toLowerCase().includes('change_me')
  ) {
    errors.push('INTERNAL_API_TOKEN is weak, placeholder, or < 32 characters');
  }

  if (
    !envData.JWT_SECRET ||
    envData.JWT_SECRET.length < 32 ||
    envData.JWT_SECRET.toLowerCase().includes('local-dev')
  ) {
    errors.push('JWT_SECRET is weak, placeholder, or < 32 characters');
  }

  if (errors.length > 0) {
    throw new Error(`Production boot guard failed:\n- ${errors.join('\n- ')}`);
  }

  return { valid: true, errors: [] };
}

export function loadEnv(overrideEnv?: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(overrideEnv ?? process.env);
  if (!result.success) {
    const formattedErrors = result.error.format();
    console.error('❌ Environment validation failed:', JSON.stringify(formattedErrors, null, 2));
    throw new Error('Environment configuration error');
  }

  const envData = result.data;
  // If strict boot guard is explicitly requested or running in strict production, validate secrets
  if (envData.ENFORCE_PRODUCTION_BOOT_GUARD) {
    validateProductionBootGuard(envData);
  }

  return envData;
}

export const env: Env = loadEnv();
