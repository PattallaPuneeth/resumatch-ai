import { Queue } from 'bullmq';
import { env } from '../config/env.js';

export const redisConnectionOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
};

export interface ResumeParsingJobPayload {
  resumeId: string;
  s3Key: string;
  mimeType: string;
}

export interface EmbeddingJobPayload {
  entityType: 'RESUME' | 'JOB';
  entityId: string;
  chunks: Array<{ id: string; text: string }>;
}

export interface MatchScoringJobPayload {
  resumeId: string;
  jobId: string;
}

export const resumeParsingQueue = new Queue<ResumeParsingJobPayload>('resume-parsing-queue', {
  connection: redisConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const embeddingQueue = new Queue<EmbeddingJobPayload>('embedding-queue', {
  connection: redisConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const matchScoringQueue = new Queue<MatchScoringJobPayload>('match-scoring-queue', {
  connection: redisConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});
