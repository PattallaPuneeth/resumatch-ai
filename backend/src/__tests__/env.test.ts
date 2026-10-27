import { describe, it, expect } from 'vitest';
import { loadEnv, EnvSchema } from '../config/env.js';

describe('Environment Configuration - INTERNAL_API_TOKEN', () => {
  const validBaseEnv: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef', // 48 chars
    INTERNAL_API_TOKEN: '12345678901234567890123456789012', // 32 chars
  };

  it('accepts valid configuration when INTERNAL_API_TOKEN is >= 32 characters', () => {
    const env = loadEnv(validBaseEnv);
    expect(env.INTERNAL_API_TOKEN).toBe('12345678901234567890123456789012');
  });

  it('refuses to start when INTERNAL_API_TOKEN is missing', () => {
    const invalidEnv = { ...validBaseEnv };
    delete invalidEnv.INTERNAL_API_TOKEN;

    expect(() => loadEnv(invalidEnv)).toThrow('Environment configuration error');
    const result = EnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('INTERNAL_API_TOKEN'));
      expect(issue).toBeDefined();
    }
  });

  it('refuses to start when INTERNAL_API_TOKEN is shorter than 32 characters', () => {
    const invalidEnv = {
      ...validBaseEnv,
      INTERNAL_API_TOKEN: 'too-short-token-only-24c', // 24 chars
    };

    expect(() => loadEnv(invalidEnv)).toThrow('Environment configuration error');
    const result = EnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('INTERNAL_API_TOKEN'));
      expect(issue?.message).toContain('at least 32 characters');
    }
  });

  it('refuses to start when INTERNAL_API_TOKEN contains CHANGE_ME placeholder', () => {
    const invalidEnv = {
      ...validBaseEnv,
      INTERNAL_API_TOKEN: 'CHANGE_ME_GENERATE_RANDOM_AT_LEAST_32_CHARS',
    };

    expect(() => loadEnv(invalidEnv)).toThrow('Environment configuration error');
    const result = EnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('INTERNAL_API_TOKEN'));
      expect(issue?.message).toContain('CHANGE_ME placeholder');
    }
  });
});

describe('Environment Configuration - JWT_SECRET (Phase 5)', () => {
  const validBaseEnv: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    INTERNAL_API_TOKEN: '12345678901234567890123456789012',
  };

  it('accepts valid JWT_SECRET >= 32 chars without forbidden words', () => {
    const parsed = loadEnv(validBaseEnv);
    expect(parsed.JWT_SECRET).toBe('0123456789abcdef0123456789abcdef0123456789abcdef');
  });

  it('refuses to start when JWT_SECRET is missing', () => {
    const invalidEnv = { ...validBaseEnv };
    delete invalidEnv.JWT_SECRET;

    expect(() => loadEnv(invalidEnv)).toThrow('Environment configuration error');
    const result = EnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('JWT_SECRET'));
      expect(issue).toBeDefined();
    }
  });

  it('refuses to start when JWT_SECRET is shorter than 32 characters', () => {
    const invalidEnv = {
      ...validBaseEnv,
      JWT_SECRET: 'short-secret-under-32-chars!!',
    };

    expect(() => loadEnv(invalidEnv)).toThrow('Environment configuration error');
    const result = EnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('JWT_SECRET'));
      expect(issue?.message).toContain('at least 32 characters');
    }
  });

  it('refuses to start when JWT_SECRET contains "local-dev" (case-insensitive)', () => {
    const invalidEnv = {
      ...validBaseEnv,
      JWT_SECRET: 'super-secure-token-with-LOCAL-DEV-suffix-12345',
    };

    expect(() => loadEnv(invalidEnv)).toThrow('Environment configuration error');
    const result = EnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('JWT_SECRET'));
      expect(issue?.message).toContain('local-dev');
    }
  });

  it('refuses to start when JWT_SECRET contains "change" (case-insensitive)', () => {
    const invalidEnv = {
      ...validBaseEnv,
      JWT_SECRET: 'super-secure-token-with-CHANGE-me-in-prod-12345',
    };

    expect(() => loadEnv(invalidEnv)).toThrow('Environment configuration error');
    const result = EnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('JWT_SECRET'));
      expect(issue?.message).toContain('change');
    }
  });
});

describe('Environment Configuration - Production Boot Guard (Phase 9 - C5)', () => {
  const prodBaseEnv: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: '4000',
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgresql://prod_user:StrongProdPass123!@db.prod.internal:5432/resumatch',
    REDIS_URL: 'redis://redis.prod.internal:6379',
    S3_ACCESS_KEY: 'prod_custom_s3_key_12345',
    S3_SECRET_KEY: 'prod_custom_s3_secret_67890',
    MINIO_ACCESS_KEY: 'prod_custom_s3_key_12345',
    MINIO_SECRET_KEY: 'prod_custom_s3_secret_67890',
    JWT_SECRET: 'super-strong-production-jwt-secret-9876543210123456789',
    INTERNAL_API_TOKEN: 'super-strong-production-internal-token-987654321',
    ALLOW_DEV_DEFAULTS: 'false',
    ENFORCE_PRODUCTION_BOOT_GUARD: 'true',
  };

  it('boots cleanly in production mode with strong unique secrets', () => {
    const loaded = loadEnv(prodBaseEnv);
    expect(loaded.NODE_ENV).toBe('production');
  });

  it('refuses to boot in production when DATABASE_URL uses default resumatch_password', () => {
    const weakEnv = {
      ...prodBaseEnv,
      DATABASE_URL: 'postgresql://resumatch_user:resumatch_password@localhost:5432/resumatch',
    };

    expect(() => loadEnv(weakEnv)).toThrow('Production boot guard failed');
    expect(() => loadEnv(weakEnv)).toThrow('resumatch_password');
  });

  it('refuses to boot in production when S3 credentials use default minioadmin', () => {
    const weakEnv = {
      ...prodBaseEnv,
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
    };

    expect(() => loadEnv(weakEnv)).toThrow('Production boot guard failed');
    expect(() => loadEnv(weakEnv)).toThrow('minioadmin');
  });

  it('refuses to boot in production when INTERNAL_API_TOKEN is weak or placeholder', () => {
    const weakEnv = {
      ...prodBaseEnv,
      INTERNAL_API_TOKEN: 'CHANGE_ME_IN_PRODUCTION_KEY_123456789',
    };

    expect(() => loadEnv(weakEnv)).toThrow('Environment configuration error');
  });
});

describe('Environment Configuration - Test Database Isolation Guard', () => {
  const testBaseEnv: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://ci_user:ci_pass@127.0.0.1:55432/resumatch_ci_test?schema=public',
    REDIS_URL: 'redis://127.0.0.1:56379',
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    INTERNAL_API_TOKEN: '12345678901234567890123456789012',
  };

  it('allows booting in test environment when pointing to isolated CI database (port 55432, resumatch_ci_test)', () => {
    const loaded = loadEnv(testBaseEnv);
    expect(loaded.NODE_ENV).toBe('test');
  });

  it('refuses to boot in test environment when DATABASE_URL points to dev port 5433', () => {
    const devPortEnv = {
      ...testBaseEnv,
      DATABASE_URL: 'postgresql://ci_user:ci_pass@127.0.0.1:5433/resumatch_ci_test?schema=public',
    };
    expect(() => loadEnv(devPortEnv)).toThrow('Refusing to run tests against development database');
  });

  it('refuses to boot in test environment when DATABASE_URL points to dev DB "resumatch"', () => {
    const devDbEnv = {
      ...testBaseEnv,
      DATABASE_URL: 'postgresql://ci_user:ci_pass@127.0.0.1:55432/resumatch?schema=public',
    };
    expect(() => loadEnv(devDbEnv)).toThrow('Refusing to run tests against development database');
  });
});
