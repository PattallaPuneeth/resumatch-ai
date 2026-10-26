import { env } from '../../config/env.js';
import type { JobSource } from './types.js';
import { MockJobSource } from './mockSource.js';
import { FirecrawlJobSource } from './firecrawlSource.js';

let customJobSource: JobSource | null = null;
let hasLoggedStatus = false;

/**
 * Resets the logging flag for tests.
 */
export function resetJobSourceLogging(): void {
  hasLoggedStatus = false;
}

/**
 * Returns the maximum number of search queries derived per suggestion request.
 * Hard-capped to 1 by default in live-verification mode to prevent credit runaway.
 */
export function getJobSourceQueryCap(): number {
  const raw = process.env.JOB_SOURCE_MAX_QUERIES || env.JOB_SOURCE_MAX_QUERIES;
  const num = Number(raw);
  if (!isNaN(num) && num > 0) {
    return Math.max(1, Math.min(3, num));
  }
  return 1;
}

/**
 * Returns the domain allowlist parsed from configuration.
 */
export function getJobSourceAllowlist(): string[] {
  const raw = (env.JOB_SOURCE_ALLOWLIST || process.env.JOB_SOURCE_ALLOWLIST || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Logs a non-secret message describing which JobSource is active and why.
 */
export function logJobSourceStatus(logger?: { info: (obj: any, msg?: string) => void }): { jobSource: 'mock' | 'firecrawl'; reason: string } {
  const queryCap = getJobSourceQueryCap();
  const allowlist = getJobSourceAllowlist();

  if (customJobSource) {
    const info = { jobSource: customJobSource.type, reason: 'custom injection', queryCap, allowlistCount: allowlist.length } as const;
    if (logger) logger.info(info, `JobSource active: ${customJobSource.type} (custom injection)`);
    return info;
  }

  const isTest = process.env.NODE_ENV === 'test' || env.NODE_ENV === 'test';
  const apiKey = (env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY || '').trim();

  if (!isTest && apiKey.length > 0) {
    const info = { jobSource: 'firecrawl' as const, reason: 'configured', queryCap, allowlistCount: allowlist.length };
    if (logger) logger.info(info, `JobSource active: firecrawl (live search enabled, queryCap=${queryCap}, allowlistCount=${allowlist.length})`);
    return info;
  }

  const reason = isTest ? 'test environment' : 'FIRECRAWL_API_KEY is not configured or empty';
  const info = { jobSource: 'mock' as const, reason, queryCap, allowlistCount: allowlist.length };
  if (logger) logger.info(info, `JobSource active: mock (${reason}, queryCap=${queryCap})`);
  return info;
}

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
export function getJobSource(logger?: { info: (obj: any, msg?: string) => void }): JobSource {
  if (!hasLoggedStatus) {
    hasLoggedStatus = true;
    logJobSourceStatus(logger);
  }

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
