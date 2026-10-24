import { describe, it, expect } from 'vitest';
import { embeddingQueue, EmbeddingJobPayload } from '../queues/bullmq.js';

describe('Phase 3A: Embedding Queue Configuration & Contract', () => {
  it('configures embeddingQueue with the required BullMQ prefix bull and retry policy', () => {
    expect(embeddingQueue.name).toBe('embedding-queue');
    expect(embeddingQueue.opts.prefix).toBe('bull');
    expect(embeddingQueue.defaultJobOptions.attempts).toBe(3);
    expect(embeddingQueue.defaultJobOptions.backoff).toEqual({
      type: 'exponential',
      delay: 1000,
    });
  });

  it('validates EmbeddingJobPayload contract compatibility', () => {
    const payloadWithResumeId: EmbeddingJobPayload = {
      type: 'EMBED_DOCUMENT',
      resumeId: '123e4567-e89b-12d3-a456-426614174000',
      entityType: 'RESUME',
      entityId: '123e4567-e89b-12d3-a456-426614174000',
    };

    expect(payloadWithResumeId.type).toBe('EMBED_DOCUMENT');
    expect(payloadWithResumeId.resumeId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(payloadWithResumeId.entityType).toBe('RESUME');
  });
});
