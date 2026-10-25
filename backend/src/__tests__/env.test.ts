import { describe, it, expect } from 'vitest';
import { loadEnv, EnvSchema } from '../config/env.js';

describe('Environment Configuration - INTERNAL_API_TOKEN', () => {
  const validBaseEnv: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'sixteen-chars-minimum-secret',
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
});
