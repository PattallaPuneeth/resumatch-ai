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
