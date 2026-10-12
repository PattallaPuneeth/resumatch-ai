import Redis from 'ioredis';
import { env } from '../config/env.js';

export function createRedisClient(): Redis {
  const options = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD ? env.REDIS_PASSWORD : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times: number) {
      const delay = Math.min(times * 100, 3000);
      return delay;
    },
    lazyConnect: true,
  };

  if (env.REDIS_URL) {
    return new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
  }

  return new Redis(options);
}

export const redisClient = createRedisClient();

export async function checkRedisHealth(): Promise<{ status: 'healthy' | 'unhealthy'; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    if (redisClient.status !== 'ready' && redisClient.status !== 'connecting') {
      await redisClient.connect().catch(() => {});
    }
    const pong = await redisClient.ping();
    if (pong === 'PONG') {
      return {
        status: 'healthy',
        latencyMs: Date.now() - start,
      };
    }
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: `Unexpected Redis ping response: ${pong}`,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Redis ping failed',
    };
  }
}
