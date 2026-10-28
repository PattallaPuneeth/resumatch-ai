import type { FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { usageService, type MeterName, type ConsumeResult } from './usageService.js';
import { redisClient } from '../queues/redis.js';
import { recordUsageRefund } from '../telemetry.js';

export interface WithMeterOptions<T> {
  amount?: number;
  shouldRefund?: (result: T) => boolean;
}

export function hashPayload(payload: any): string {
  if (payload === undefined || payload === null) {
    return 'empty';
  }
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Sends an RFC 7807 Usage Limit Exceeded Problem Details response.
 */
export function sendUsageLimitExceeded(
  reply: FastifyReply,
  request: FastifyRequest,
  consumeResult: ConsumeResult
): void {
  const { meter, used, limit, resetAt } = consumeResult;
  const detail = `Usage limit reached for meter "${meter}". Current usage: ${used}/${limit}.${
    resetAt ? ` Next reset: ${resetAt}.` : ''
  }`;

  reply
    .status(429)
    .header('Content-Type', 'application/problem+json; charset=utf-8')
    .send({
      type: 'https://api.resumatch.ai/errors/usage-limit-exceeded',
      title: 'Usage Limit Exceeded',
      status: 429,
      statusCode: 429,
      error: 'Too Many Requests',
      message: detail,
      detail,
      instance: request.url,
      meter,
      used,
      limit,
      resetAt,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
}

/**
 * Reusable withMeter guard executed after auth, ownership and input validation
 * and before the downstream expensive action.
 *
 * Automatically checks Idempotency-Key header:
 * - If already completed, returns cached result with X-Idempotency-Replay: true (zero quota consumed).
 * - If in-progress, returns HTTP 409 Conflict.
 * - Atomically consumes usage units only on new requests.
 */
export async function withMeter<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  meter: MeterName,
  action: () => Promise<T>,
  options?: WithMeterOptions<T>
): Promise<T | void> {
  const user = request.user as any;
  const userId: string = user?.userId || user?.sub;

  if (!userId) {
    throw new Error('withMeter invoked without authenticated user context');
  }

  const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
  let redisKey: string | null = null;
  let currentHash: string | null = null;

  if (idempotencyKey && typeof idempotencyKey === 'string' && idempotencyKey.trim() !== '') {
    redisKey = `idempotency:${userId}:${idempotencyKey.trim()}`;
    currentHash = hashPayload(request.body);

    const rawExisting = await redisClient.get(redisKey).catch(() => null);
    if (rawExisting) {
      try {
        const record = JSON.parse(rawExisting);
        if (record.payloadHash && record.payloadHash !== currentHash) {
          reply.status(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: 'Idempotency key was previously used with a different request payload',
          });
          return;
        }
        if (record.status === 'IN_PROGRESS') {
          reply.status(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: 'A request with this idempotency key is currently being processed',
          });
          return;
        }
        if (record.status === 'COMPLETED') {
          reply
            .status(record.statusCode || 200)
            .header('X-Idempotency-Replay', 'true')
            .send(record.responseBody);
          return;
        }
      } catch {
        // Fall through on JSON parse error
      }
    }

    // Acquire in-progress lock
    const inProgressRecord = JSON.stringify({
      status: 'IN_PROGRESS',
      payloadHash: currentHash,
      createdAt: new Date().toISOString(),
    });

    const acquired = await redisClient
      .set(redisKey, inProgressRecord, 'EX' as any, 60, 'NX' as any)
      .catch(() => 'OK');

    if (!acquired) {
      reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'A concurrent request with this idempotency key is already running',
      });
      return;
    }
  }

  const amount = options?.amount ?? 1;
  const consumeRes = await usageService.consume(userId, meter, amount);

  if (!consumeRes.allowed) {
    if (redisKey) {
      await redisClient.del(redisKey).catch(() => {});
    }
    sendUsageLimitExceeded(reply, request, consumeRes);
    return;
  }

  let result: T;
  try {
    result = await action();
  } catch (downstreamErr) {
    if (redisKey) {
      await redisClient.del(redisKey).catch(() => {});
    }
    // Refund on downstream 5xx / timeout / network failure
    try {
      await usageService.refund(userId, meter, amount);
      recordUsageRefund(meter, 'downstream_error');
    } catch (refundErr) {
      request.log.error({ err: refundErr, userId, meter }, 'Failed to refund meter on downstream exception');
    }
    throw downstreamErr;
  }

  // Check if result indicates refund is needed (e.g. HALLUCINATION_DETECTED)
  if (options?.shouldRefund && options.shouldRefund(result)) {
    try {
      await usageService.refund(userId, meter, amount);
      recordUsageRefund(meter, 'verification');
    } catch (refundErr) {
      request.log.error({ err: refundErr, userId, meter }, 'Failed to refund meter on shouldRefund condition');
    }
  }

  // Save successful response to idempotency cache
  if (redisKey && currentHash) {
    const completedRecord = JSON.stringify({
      status: 'COMPLETED',
      payloadHash: currentHash,
      statusCode: 200,
      responseBody: result,
      createdAt: new Date().toISOString(),
    });
    await redisClient.set(redisKey, completedRecord, 'EX' as any, 86400).catch(() => {});
  }

  return result;
}
