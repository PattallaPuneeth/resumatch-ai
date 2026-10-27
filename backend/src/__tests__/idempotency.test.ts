/**
 * Phase 10A - Item C4: Idempotency Service Unit Tests
 *
 * Validates Idempotency-Key handling:
 * - Duplicate requests replay cached response with X-Idempotency-Replay: true
 * - Handler runs only once (prevents double metering)
 * - Mismatched payload returns 422
 * - Concurrent in-progress request returns 409
 * - Absence of key executes normally
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withIdempotency, hashPayload } from '../services/idempotency.js';

// In-memory mock Redis for isolated unit tests
const mockStore = new Map<string, { value: string; ttl: number }>();

vi.mock('../queues/redis.js', () => ({
  redisClient: {
    get: vi.fn(async (key: string) => {
      const entry = mockStore.get(key);
      return entry ? entry.value : null;
    }),
    set: vi.fn(async (key: string, value: string, _mode?: string, _duration?: number, nx?: string) => {
      if (nx === 'NX' && mockStore.has(key)) {
        return null; // Not acquired
      }
      mockStore.set(key, { value, ttl: 86400 });
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      mockStore.delete(key);
      return 1;
    }),
  },
}));

describe('C4: Idempotency Service', () => {
  beforeEach(() => {
    mockStore.clear();
    vi.clearAllMocks();
  });

  function createMockReply() {
    const reply: any = {
      _status: 200,
      _headers: {} as Record<string, string>,
      _body: null as any,
      status: vi.fn(function (code: number) {
        reply._status = code;
        return reply;
      }),
      header: vi.fn(function (key: string, value: string) {
        reply._headers[key] = value;
        return reply;
      }),
      send: vi.fn(function (payload: any) {
        reply._body = payload;
        return reply;
      }),
    };
    return reply;
  }

  it('computes deterministic SHA-256 hashes of payloads', () => {
    const h1 = hashPayload({ a: 1, b: 'test' });
    const h2 = hashPayload({ a: 1, b: 'test' });
    const h3 = hashPayload({ a: 2, b: 'test' });

    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(hashPayload(null)).toBe('empty');
  });

  it('executes handler normally when Idempotency-Key is absent', async () => {
    const request: any = {
      headers: {},
      body: { action: 'test' },
      user: { userId: 'u1' },
    };
    const reply = createMockReply();
    const handler = vi.fn().mockResolvedValue({ statusCode: 200, body: { result: 'ok' } });

    await withIdempotency(request, reply, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ result: 'ok' });
    expect(reply._headers['X-Idempotency-Replay']).toBeUndefined();
  });

  it('caches response on first call and replays with header without re-executing handler', async () => {
    const request: any = {
      headers: { 'idempotency-key': 'idemp-key-123' },
      body: { bullet: 'Led high-scale backend systems' },
      user: { userId: 'u1' },
    };
    const handler = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: { rewrittenBullet: 'Architected high-throughput backend services' },
    });

    // 1. Initial Request
    const reply1 = createMockReply();
    await withIdempotency(request, reply1, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(reply1._status).toBe(200);
    expect(reply1._body).toEqual({ rewrittenBullet: 'Architected high-throughput backend services' });
    expect(reply1._headers['X-Idempotency-Replay']).toBeUndefined();

    // 2. Duplicate Replay Request
    const reply2 = createMockReply();
    await withIdempotency(request, reply2, handler);

    // Handler must NOT have been called a second time
    expect(handler).toHaveBeenCalledTimes(1);
    expect(reply2._status).toBe(200);
    expect(reply2._body).toEqual({ rewrittenBullet: 'Architected high-throughput backend services' });
    expect(reply2._headers['X-Idempotency-Replay']).toBe('true');
  });

  it('rejects duplicate Idempotency-Key with mismatched payload with 422', async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 200, body: { result: '1' } });

    // 1. First request with payload A
    const req1: any = {
      headers: { 'idempotency-key': 'reused-key' },
      body: { query: 'first payload' },
      user: { userId: 'u1' },
    };
    const reply1 = createMockReply();
    await withIdempotency(req1, reply1, handler);

    // 2. Second request with reused key but DIFFERENT payload B
    const req2: any = {
      headers: { 'idempotency-key': 'reused-key' },
      body: { query: 'totally different payload' },
      user: { userId: 'u1' },
    };
    const reply2 = createMockReply();
    await withIdempotency(req2, reply2, handler);

    expect(reply2._status).toBe(422);
    expect(reply2._body.message).toMatch(/different request payload/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects concurrent request with same Idempotency-Key with 409 Conflict', async () => {
    // Manually set in-progress lock in store
    const hash = hashPayload({ test: 'concurrent' });
    mockStore.set('idempotency:u1:concurrent-key', {
      value: JSON.stringify({ status: 'IN_PROGRESS', payloadHash: hash, createdAt: '' }),
      ttl: 60,
    });

    const req: any = {
      headers: { 'idempotency-key': 'concurrent-key' },
      body: { test: 'concurrent' },
      user: { userId: 'u1' },
    };
    const reply = createMockReply();
    const handler = vi.fn();

    await withIdempotency(req, reply, handler);

    expect(reply._status).toBe(409);
    expect(reply._body.message).toMatch(/currently being processed/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('cleans up in-progress lock if handler throws an error', async () => {
    const req: any = {
      headers: { 'idempotency-key': 'crash-key' },
      body: { fail: true },
      user: { userId: 'u1' },
    };
    const reply = createMockReply();
    const handler = vi.fn().mockRejectedValue(new Error('Downstream DB error'));

    await expect(withIdempotency(req, reply, handler)).rejects.toThrow('Downstream DB error');

    // The key should have been deleted from store allowing subsequent retries
    expect(mockStore.has('idempotency:u1:crash-key')).toBe(false);
  });
});
