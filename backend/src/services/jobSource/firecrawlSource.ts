import crypto from 'crypto';
import type { JobSearchQuery, JobSource, JobSourceOptions, RawJobListing } from './types.js';
import { validateUrlForSsrf } from './ssrfGuard.js';
import { sanitizeScrapedContent } from './sanitizer.js';

export interface FirecrawlSearchResultItem {
  url?: string;
  title?: string;
  description?: string;
  markdown?: string;
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
  };
}

export interface FirecrawlSearchApiResponse {
  success: boolean;
  data?: FirecrawlSearchResultItem[];
  error?: string;
}

/**
 * FirecrawlJobSource: web search adapter querying Firecrawl's search API.
 * Marked as TEMPORARY and swappable for licensed enterprise job APIs.
 */
export class FirecrawlJobSource implements JobSource {
  public readonly type = 'firecrawl' as const;
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(apiKey: string, endpoint: string = 'https://api.firecrawl.dev/v1/search') {
    this.apiKey = apiKey.trim();
    this.endpoint = endpoint.trim();
  }

  public async searchJobs(
    query: JobSearchQuery,
    options?: JobSourceOptions
  ): Promise<RawJobListing[]> {
    if (!this.apiKey) {
      throw new Error('FIRECRAWL_API_KEY is not configured for FirecrawlJobSource');
    }

    const timeoutMs = options?.timeoutMs ?? 15000;
    // Hard cap maxResults to at most 3 to enforce strict credit budgeting
    const maxResults = Math.min(3, Math.max(1, options?.maxResults ?? query.limit ?? 3));
    const allowlist = options?.allowlist ?? [];

    const searchQuery = [query.query, query.location, query.seniority, 'jobs']
      .filter(Boolean)
      .join(' ')
      .trim();

    // 1. Execute search with 1 retry on 5xx / network timeout (scrape options disabled)
    const apiResponse = await this.executeWithRetry(
      searchQuery,
      maxResults,
      timeoutMs
    );

    if (!apiResponse.success || !Array.isArray(apiResponse.data)) {
      throw new Error(`Firecrawl search failed: ${apiResponse.error || 'Unknown error'}`);
    }

    // 2. Validate, filter, and sanitize returned listings
    const validListings: RawJobListing[] = [];

    for (const item of apiResponse.data) {
      const rawUrl = item.url || item.metadata?.sourceURL;
      if (!rawUrl) continue;

      // SSRF and Denylist / Allowlist check
      const ssrfCheck = await validateUrlForSsrf(rawUrl, allowlist);
      if (!ssrfCheck.safe) {
        // Discard unsafe or denylisted listings
        continue;
      }

      const rawTitle = item.title || item.metadata?.title || 'Job Opening';
      const rawBody = item.markdown || item.description || item.metadata?.description || '';
      const cleaned = sanitizeScrapedContent(rawBody);

      if (!cleaned || cleaned.length < 30) {
        // Skip empty or unreadable snippets
        continue;
      }

      // Infer company name from title or URL hostname
      let company = 'Unknown Company';
      try {
        const parsedUrl = new URL(rawUrl);
        const hostParts = parsedUrl.hostname.split('.');
        if (hostParts.length >= 2) {
          const mainDomain = hostParts[hostParts.length - 2];
          company = mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1);
        }
      } catch {
        // Keep default
      }

      const urlHash = crypto.createHash('sha256').update(rawUrl).digest('hex');
      const contentHash = crypto.createHash('sha256').update(cleaned).digest('hex');

      validListings.push({
        sourceUrl: rawUrl,
        title: rawTitle.slice(0, 200),
        company: company.slice(0, 200),
        location: query.location || null,
        rawDescription: rawBody.slice(0, 10000),
        cleanedText: cleaned,
        contentHash,
        urlHash,
        fetchedAt: new Date().toISOString(),
      });

      if (validListings.length >= maxResults) {
        break;
      }
    }

    return validListings;
  }

  /**
   * Executes fetch with timeout and 1 exponential-backoff retry on 5xx/timeout.
   */
  private async executeWithRetry(
    query: string,
    limit: number,
    timeoutMs: number
  ): Promise<FirecrawlSearchApiResponse> {
    const maxAttempts = 2;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        // Non-secret outbound logging for ledger and auditability
        console.log(
          JSON.stringify({
            level: 30,
            time: Date.now(),
            provider: 'firecrawl',
            endpoint: this.endpoint,
            limit,
            scrape: false,
            msg: `[FIRECRAWL] Outbound search request: limit=${limit}, scrape=false`,
          })
        );

        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': 'ResuMatchBot/1.0 (+https://resumatch.ai/bot)',
          },
          body: JSON.stringify({
            query,
            limit,
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          const json = (await response.json()) as FirecrawlSearchApiResponse;
          return json;
        }

        // Check if retryable (5xx or 429)
        if (response.status >= 500 || response.status === 429) {
          lastError = new Error(`Firecrawl returned HTTP ${response.status}: ${await response.text().catch(() => '')}`);
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            continue;
          }
        } else {
          // 4xx client errors should not be retried
          const errorBody = await response.text().catch(() => '');
          throw new Error(`Firecrawl API error (HTTP ${response.status}): ${errorBody}`);
        }
      } catch (err: any) {
        clearTimeout(timer);
        lastError = err;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
      }
    }

    throw lastError || new Error('Firecrawl search request failed');
  }
}
