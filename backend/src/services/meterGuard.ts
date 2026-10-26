import type { FastifyReply, FastifyRequest } from 'fastify';
import { usageService, type MeterName, type ConsumeResult } from './usageService.js';

export interface WithMeterOptions<T> {
  amount?: number;
  shouldRefund?: (result: T) => boolean;
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
 * Atomically consumes usage units. If blocked, emits HTTP 429 RFC 7807 without
 * invoking the downstream action. If downstream execution throws or fails with
 * a non-usable result (5xx, timeout, or HALLUCINATION_DETECTED), it refunds the
 * consumed units.
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

  const amount = options?.amount ?? 1;
  const consumeRes = await usageService.consume(userId, meter, amount);

  if (!consumeRes.allowed) {
    sendUsageLimitExceeded(reply, request, consumeRes);
    return;
  }

  let result: T;
  try {
    result = await action();
  } catch (downstreamErr) {
    // Refund on downstream 5xx / timeout / network failure
    try {
      await usageService.refund(userId, meter, amount);
    } catch (refundErr) {
      request.log.error({ err: refundErr, userId, meter }, 'Failed to refund meter on downstream exception');
    }
    throw downstreamErr;
  }

  // Check if result indicates refund is needed (e.g. HALLUCINATION_DETECTED)
  if (options?.shouldRefund && options.shouldRefund(result)) {
    try {
      await usageService.refund(userId, meter, amount);
    } catch (refundErr) {
      request.log.error({ err: refundErr, userId, meter }, 'Failed to refund meter on shouldRefund condition');
    }
  }

  return result;
}
