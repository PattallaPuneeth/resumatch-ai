import { z } from 'zod';

export interface JobSearchQuery {
  query: string;
  location?: string;
  seniority?: string;
  limit?: number;
}

export interface RawJobListing {
  id?: string;
  sourceUrl: string;
  title: string;
  company: string;
  location?: string | null;
  rawDescription: string;
  cleanedText: string;
  contentHash: string;
  urlHash: string;
  fetchedAt: string;
}

export interface JobSourceOptions {
  timeoutMs?: number;
  maxResults?: number;
  allowlist?: string[];
}

export interface JobSource {
  readonly type: 'mock' | 'firecrawl';
  searchJobs(query: JobSearchQuery, options?: JobSourceOptions): Promise<RawJobListing[]>;
}

export const jobSuggestionsBodySchema = z.object({
  jobId: z.guid('Invalid job UUID').optional(),
  location: z.string().max(100, 'Location too long').optional(),
  seniority: z.string().max(50, 'Seniority too long').optional(),
  limit: z.coerce.number().int().min(1).max(10).default(10).optional(),
});

export type JobSuggestionsBody = z.infer<typeof jobSuggestionsBodySchema>;

export interface ScoredJobSuggestion {
  title: string;
  company: string;
  location: string | null;
  sourceUrl: string;
  matchScore: number;
  matchedSkills: string[];
  missingSkills: string[];
  fetchedAt: string;
}

export interface JobSuggestionsResponse {
  resumeId: string;
  totalFound: number;
  suggestions: ScoredJobSuggestion[];
  message?: string;
  source: 'mock' | 'firecrawl';
  isSample: boolean;
}
