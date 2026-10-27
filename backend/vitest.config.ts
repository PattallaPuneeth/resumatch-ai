import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-fake-jwt-secret-for-vitest-runs-only-32chars',
      INTERNAL_API_TOKEN: 'test-fake-internal-api-token-vitest-32chars',
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://ci_test_user:ci_test_password_123@127.0.0.1:55432/resumatch_ci_test?schema=public',
      REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
      REDIS_PORT: process.env.REDIS_PORT || '56379',
      REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:56379',
      S3_ENDPOINT: process.env.S3_ENDPOINT || 'http://127.0.0.1:59000',
      S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT || 'http://127.0.0.1:59000',
      MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || '127.0.0.1',
      MINIO_PORT: process.env.MINIO_PORT || '59000',
      MINIO_USE_SSL: 'false',
      MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || 'ci_minio_user',
      MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || 'ci_minio_password_123',
      S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || 'ci_minio_user',
      S3_SECRET_KEY: process.env.S3_SECRET_KEY || 'ci_minio_password_123',
      S3_BUCKET: 'resumes',
      MINIO_BUCKET_NAME: 'resumes',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
