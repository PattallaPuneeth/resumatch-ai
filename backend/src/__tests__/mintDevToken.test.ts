import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDevToken } from '../scripts/mintDevToken.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';

vi.mock('../db/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../storage/s3.js', () => ({
  checkS3Health: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

vi.mock('../queues/redis.js', () => ({
  redisClient: {
    quit: vi.fn().mockResolvedValue('OK'),
    status: 'ready',
    ping: vi.fn().mockResolvedValue('PONG'),
  },
  checkRedisHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
  createRedisClient: vi.fn(),
}));

vi.mock('../storage/minio.js', () => ({
  checkMinioHealth: vi.fn().mockResolvedValue({ status: 'healthy', latencyMs: 1 }),
}));

describe('Developer Token Minting (mintDevToken)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects execution when NODE_ENV is production', async () => {
    const originalNodeEnv = env.NODE_ENV;
    try {
      (env as { NODE_ENV: string }).NODE_ENV = 'production';
      await expect(generateDevToken()).rejects.toThrow('mintDevToken is strictly forbidden in production');
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = originalNodeEnv;
    }
  });

  it('fails when database query throws an error', async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValueOnce(new Error('Connection terminated'));
    await expect(generateDevToken('demo@resumatch.ai')).rejects.toThrow(
      'Database query failed while looking up user'
    );
  });

  it('fails when user is not found in database', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    await expect(generateDevToken('nonexistent@example.com')).rejects.toThrow(
      'User with email "nonexistent@example.com" not found in database'
    );
  });

  it('successfully generates token for an existing user with correct user ID', async () => {
    const mockUser = {
      id: 'mock-user-uuid-1234',
      email: 'demo@resumatch.ai',
      fullName: 'Demo User',
      passwordHash: null,
      role: 'CANDIDATE',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(mockUser as any);

    const result = await generateDevToken('demo@resumatch.ai');
    expect(result.userId).toBe('mock-user-uuid-1234');
    expect(result.email).toBe('demo@resumatch.ai');
    expect(typeof result.token).toBe('string');
    expect(result.token.split('.')).toHaveLength(3); // Standard JWT 3 parts
  });
});
