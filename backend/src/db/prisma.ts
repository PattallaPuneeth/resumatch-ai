import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    datasources: {
      db: {
        url: env.DATABASE_URL,
      },
    },
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

export async function checkDatabaseHealth(): Promise<{ status: 'healthy' | 'unhealthy'; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Database query failed',
    };
  }
}
