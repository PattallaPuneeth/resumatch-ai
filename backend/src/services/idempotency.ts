/**
 * Phase 10A - Item C4: Request Idempotency via Redis
 *
 * Implements Idempotency-Key header processing for metered POST endpoints.
 * - Stores state in Redis with 24h TTL (86400s).
 * - Enforces payload hashing: detects key reuse with mismatched payloads (HTTP 422).
 * - Prevents race conditions with distributed atomic lock (HTTP 409 if in-progress).
 * - Serves cached replay with header `X-Idempotency-Replay: true` without double metering.
 */

import crypto from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { redisClient } from '../queues/redis.js';

export interface IdempotencyRecord {
  status: 'IN_PROGRESS' | 'COMPLETED';
  payloadHash: string;
  statusCode?: number;
  responseBody?: any;
  createdAt: string;
}

export const IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours
export const IN_PROGRESS_LOCK_TTL_SECONDS = 60; // 1 minute lock for in-flight requests

export function hashPayload(payload: any): string {
  if (payload === undefined || payload === null) {
    return 'empty';
  }
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHash('sha256').update(str).digest('hex');
}

export async function withIdempotency(
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<{ statusCode: number; body: any }>
): Promise<void> {
  const idempotencyKey = request.headers['idempotency-key'] as string | undefined;

  // If no Idempotency-Key header was provided, execute standard handler directly
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    const result = await handler();
    reply.status(result.statusCode).send(result.body);
    return;
  }

  const user = request.user as any;
  const userId: string = user?.userId || user?.sub || 'anonymous';
  const redisKey = `idempotency:${userId}:${idempotencyKey.trim()}`;
  const currentHash = hashPayload(request.body);

  // 1. Check existing record in Redis
  const rawExisting = await redisClient.get(redisKey);
  if (rawExisting) {
    let record: IdempotencyRecord;
    try {
      record = JSON.parse(rawExisting);
    } catch {
      record = { status: 'IN_PROGRESS', payloadHash: '', createdAt: '' };
    }

    // Verify payload hash matches
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

    if (record.status === 'COMPLETED' && record.statusCode) {
      reply
        .status(record.statusCode)
        .header('X-Idempotency-Replay', 'true')
        .send(record.responseBody);
      return;
    }
  }

  // 2. Acquire in-progress lock via Redis SET NX
  const inProgressRecord: IdempotencyRecord = {
    status: 'IN_PROGRESS',
    payloadHash: currentHash,
    createdAt: new Date().toISOString(),
  };

  const acquired = await redisClient.set(
    redisKey,
    JSON.stringify(inProgressRecord),
    'EX',
    IN_PROGRESS_LOCK_TTL_SECONDS,
    'NX'
  );

  if (!acquired) {
    reply.status(409).send({
      statusCode: 409,
      error: 'Conflict',
      message: 'A concurrent request with this idempotency key is already running',
    });
    return;
  }

  // 3. Execute handler and cache completed result
  try {
    const result = await handler();

    const completedRecord: IdempotencyRecord = {
      status: 'COMPLETED',
      payloadHash: currentHash,
      statusCode: result.statusCode,
      responseBody: result.body,
      createdAt: new Date().toISOString(),
    };

    await redisClient.set(
      redisKey,
      JSON.stringify(completedRecord),
      'EX',
      IDEMPOTENCY_TTL_SECONDS
    );

    reply.status(result.statusCode).send(result.body);
  } catch (err) {
    // Release in-progress lock on unhandled crash so client can retry
    await redisClient.del(redisKey);
    throw err;
  }
}
