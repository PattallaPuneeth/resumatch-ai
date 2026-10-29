import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export function configureDatabaseUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(env.DB_CONNECTION_LIMIT));
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', String(env.DB_POOL_TIMEOUT));
    }
    if (!url.searchParams.has('statement_timeout')) {
      url.searchParams.set('statement_timeout', String(env.DB_STATEMENT_TIMEOUT_MS));
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    datasources: {
      db: {
        url: configureDatabaseUrl(env.DATABASE_URL),
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
