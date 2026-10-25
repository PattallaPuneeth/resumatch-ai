import type { FastifyRequest, FastifyReply } from 'fastify';
import { redisClient } from '../queues/redis.js';
import { env } from '../config/env.js';

export class RedisUnavailableError extends Error {
  constructor(message = 'Redis is unavailable') {
    super(message);
    this.name = 'RedisUnavailableError';
  }
}

export function getClientIp(request: FastifyRequest): string {
  if (env.TRUST_PROXY) {
    const xff = request.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim() !== '') {
      return xff.split(',')[0].trim();
    }
  }
  return request.ip || '127.0.0.1';
}

async function ensureRedisConnected(): Promise<void> {
  if (redisClient.status !== 'ready' && redisClient.status !== 'connecting') {
    await redisClient.connect().catch((err) => {
      throw new RedisUnavailableError(err?.message || 'Failed to connect to Redis');
    });
  }
}

/**
 * Checks per-IP rate limit on /v1/auth routes.
 * Default: 60 requests per 1 minute window.
 */
export async function checkIpRateLimit(
  ip: string,
  limit = 60,
  windowSeconds = 60
): Promise<{ allowed: boolean; retryAfter?: number }> {
  try {
    await ensureRedisConnected();
    const key = `ratelimit:auth:ip:${ip}`;
    const current = await redisClient.incr(key);
    if (current === 1) {
      await redisClient.expire(key, windowSeconds);
    }
    if (current > limit) {
      const ttl = await redisClient.ttl(key);
      return { allowed: false, retryAfter: ttl > 0 ? ttl : windowSeconds };
    }
    return { allowed: true };
  } catch (err: any) {
    if (err instanceof RedisUnavailableError) {
      throw err;
    }
    throw new RedisUnavailableError(err?.message || 'Redis rate limit check failed');
  }
}

/**
 * Checks whether an account (keyed by lowercase username) is locked out.
 */
export async function checkAccountLockout(
  usernameLower: string
): Promise<{ locked: boolean; retryAfter?: number }> {
  try {
    await ensureRedisConnected();
    const lockoutKey = `auth:lockout:${usernameLower}`;
    const ttl = await redisClient.ttl(lockoutKey);
    if (ttl > 0) {
      return { locked: true, retryAfter: ttl };
    }
    return { locked: false };
  } catch (err: any) {
    if (err instanceof RedisUnavailableError) {
      throw err;
    }
    throw new RedisUnavailableError(err?.message || 'Redis lockout check failed');
  }
}

/**
 * Records a failed login attempt for an account (keyed by lowercase username).
 * Returns whether account became locked out and for how many seconds.
 */
export async function recordFailedLogin(
  usernameLower: string
): Promise<{ locked: boolean; lockoutSeconds?: number; failedAttempts: number }> {
  try {
    await ensureRedisConnected();
    const countKey = `auth:failed_login:${usernameLower}`;
    const failedAttempts = await redisClient.incr(countKey);
    if (failedAttempts === 1) {
      await redisClient.expire(countKey, 86400); // 24-hour expiration on attempt counter
    }

    // Exponential lockout starting at 5 failed attempts:
    // 5 -> 60s (1m)
    // 6 -> 120s (2m)
    // 7 -> 240s (4m)
    // 8 -> 480s (8m)
    // 9 -> 960s (16m)
    // 10+ -> 1800s (30m cap)
    if (failedAttempts >= 5) {
      const exponent = failedAttempts - 5;
      const lockoutSeconds = Math.min(1800, 60 * Math.pow(2, exponent));
      const lockoutKey = `auth:lockout:${usernameLower}`;
      await redisClient.set(lockoutKey, '1', 'EX', lockoutSeconds);
      return { locked: true, lockoutSeconds, failedAttempts };
    }

    return { locked: false, failedAttempts };
  } catch (err: any) {
    if (err instanceof RedisUnavailableError) {
      throw err;
    }
    throw new RedisUnavailableError(err?.message || 'Redis record failed login failed');
  }
}

/**
 * Resets failed login counters and active lockout on successful login.
 */
export async function recordSuccessfulLogin(usernameLower: string): Promise<void> {
  try {
    await ensureRedisConnected();
    const countKey = `auth:failed_login:${usernameLower}`;
    const lockoutKey = `auth:lockout:${usernameLower}`;
    await redisClient.del(countKey, lockoutKey);
  } catch (err: any) {
    if (err instanceof RedisUnavailableError) {
      throw err;
    }
    throw new RedisUnavailableError(err?.message || 'Redis reset login failed');
  }
}

/**
 * Fastify preHandler hook for IP-level rate limiting on /v1/auth routes.
 * Fails CLOSED with HTTP 503 if Redis is unreachable.
 */
export async function authRateLimitHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const ip = getClientIp(request);
    const limit = env.NODE_ENV === 'test' ? 1000 : 60;
    const result = await checkIpRateLimit(ip, limit);
    if (!result.allowed) {
      const retryAfter = result.retryAfter ?? 60;
      reply.header('Retry-After', String(retryAfter));
      return reply.status(429).send({
        type: 'https://httpstatuses.com/429',
        title: 'Too Many Requests',
        status: 429,
        detail: `Too many authentication requests from this IP address. Please retry in ${retryAfter} seconds.`,
        instance: request.url,
      });
    }
  } catch (err) {
    request.log.error({ err }, 'Redis failure during IP rate limit check - failing closed with 503');
    return reply.status(503).send({
      type: 'https://httpstatuses.com/503',
      title: 'Service Unavailable',
      status: 503,
      detail: 'Authentication service is temporarily unavailable. Please retry later.',
      instance: request.url,
    });
  }
}
