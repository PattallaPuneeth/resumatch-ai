import { env } from '../../config/env.js';
import type { JobSource } from './types.js';
import { MockJobSource } from './mockSource.js';
import { FirecrawlJobSource } from './firecrawlSource.js';

let customJobSource: JobSource | null = null;

/**
 * Sets a custom JobSource for testing or administrative injection.
 */
export function setJobSource(source: JobSource | null): void {
  customJobSource = source;
}

/**
 * Factory picking FirecrawlJobSource only when FIRECRAWL_API_KEY is configured
 * and NODE_ENV is not 'test'. Otherwise falls back to MockJobSource.
 */
export function getJobSource(): JobSource {
  if (customJobSource) {
    return customJobSource;
  }

  const isTest = process.env.NODE_ENV === 'test' || env.NODE_ENV === 'test';
  const apiKey = (env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY || '').trim();

  if (!isTest && apiKey.length > 0) {
    return new FirecrawlJobSource(apiKey);
  }

  return new MockJobSource();
}
