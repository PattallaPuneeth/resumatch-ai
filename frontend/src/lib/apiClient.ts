/**
 * ResuMatch AI - Production Typed API Client (Phase 8A)
 *
 * Implements:
 * - Same-origin requests via Next.js proxy (/api/backend)
 * - First-party cookie credentials (credentials: 'include')
 * - CSRF double-submit header (x-csrf-token) on state-changing requests
 * - Single-flight refresh token queue on 401 (prevents refresh storms and infinite loops)
 * - RFC 7807 problem details error handling with typed meter and limit information
 * - Request timeouts via AbortController
 * - Zero tokens in localStorage/sessionStorage
 */

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  statusCode?: number;
  detail?: string;
  message?: string;
  error?: string;
  instance?: string;
  meter?: 'analyses' | 'job_suggestions' | 'resume_storage_bytes';
  used?: number;
  limit?: number | null;
  resetAt?: string | null;
  timestamp?: string;
  requestId?: string;
  details?: unknown;
}

export class ApiProblemError extends Error {
  public readonly status: number;
  public readonly title: string;
  public readonly detail: string;
  public readonly type?: string;
  public readonly instance?: string;
  public readonly meter?: 'analyses' | 'job_suggestions' | 'resume_storage_bytes';
  public readonly used?: number;
  public readonly limit?: number | null;
  public readonly resetAt?: string | null;
  public readonly retryAfter?: number | null;
  public readonly raw: ProblemDetails;

  constructor(status: number, problem: ProblemDetails, retryAfter?: number | null) {
    const message = problem.detail || problem.message || problem.title || `HTTP ${status}`;
    super(message);
    this.name = 'ApiProblemError';
    this.status = status;
    this.title = problem.title || problem.error || 'Request Error';
    this.detail = message;
    this.type = problem.type;
    this.instance = problem.instance;
    this.meter = problem.meter;
    this.used = problem.used;
    this.limit = problem.limit;
    this.resetAt = problem.resetAt;
    this.retryAfter = retryAfter ?? null;
    this.raw = problem;
  }
}

// ---------------------------------------------------------------------------
// Typed Models
// ---------------------------------------------------------------------------

export interface UserSummary {
  id: string;
  username: string;
  email?: string | null;
  role?: string;
  createdAt?: string;
}

export interface AuthSuccessResponse {
  user: UserSummary;
  tokens?: {
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
  };
  recoveryCodes?: string[];
  message?: string;
}

export type MeterName = 'analyses' | 'job_suggestions' | 'resume_storage_bytes';

export interface MeterUsageState {
  used: number;
  limit: number | null;
  unlimited: boolean;
  percent: number | null;
  activeThreshold: 50 | 70 | 90 | 100 | null;
  crossedThresholds: number[];
  blocked: boolean;
  periodStart: string | null;
  resetAt: string | null;
}

export interface UserUsageResponse {
  plan: string;
  planName: string;
  period: string;
  periodStart: string;
  resetAt: string;
  meters: Record<MeterName, MeterUsageState>;
}

export interface ResumeSummary {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: 'UPLOAD_PENDING' | 'PROCESSING' | 'PARSED' | 'FAILED';
  extractionMethod?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  atsScore?: number | null;
}

export interface ParsedResumeDetails {
  id: string;
  rawText: string;
  candidateName?: string | null;
  contactInfo?: {
    email?: string | null;
    phone?: string | null;
    linkedin?: string | null;
    github?: string | null;
    location?: string | null;
  } | null;
  summary?: string | null;
  skills?: Array<{
    name: string;
    category: string;
    confidence: number;
    startChar: number;
    endChar: number;
  }> | null;
  experience?: Array<{
    title?: string | null;
    company?: string | null;
    location?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    description?: string | null;
    startChar: number;
    endChar: number;
  }> | null;
  education?: Array<{
    degree?: string | null;
    institution?: string | null;
    year?: string | null;
    gpa?: string | null;
    startChar: number;
    endChar: number;
  }> | null;
  atsScore?: number | null;
  atsHazards?: Array<{
    type: string;
    severity: string;
    message: string;
    details?: unknown;
  }> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeDetailsResponse extends ResumeSummary {
  parsedResume?: ParsedResumeDetails | null;
}

export interface UploadUrlRequest {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadUrlResponse {
  resumeId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresIn: number;
  storageKey: string;
}

export interface CompleteUploadResponse {
  resumeId: string;
  status: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Phase 8B: Jobs, Match, Analysis, Improvements & Suggestions Types
// ---------------------------------------------------------------------------

export interface CreateJobRequest {
  title: string;
  company: string;
  rawDescription: string;
  location?: string;
  jobType?: string;
  requiredSkills?: string[];
  preferredSkills?: string[];
  experienceLevel?: string;
}

export interface JobSummary {
  id: string;
  title: string;
  company: string;
  location?: string | null;
  jobType?: string | null;
  status: string;
  createdAt: string;
}

export interface JobDetails extends JobSummary {
  rawDescription: string;
  requiredSkills: string[];
  preferredSkills: string[];
  experienceLevel?: string | null;
  chunkCount: number;
  updatedAt: string;
}

export interface MatchScoringBreakdown {
  bm25TopScore?: number;
  vectorSimilarity?: number;
  rrfScore?: number;
  crossEncoderScore?: number;
  skillCoverage?: number;
}

export interface MatchExplanation {
  skillGap?: {
    matched: string[];
    missing: string[];
    partial: string[];
    coverage_ratio?: number;
  };
  scoringBreakdown?: MatchScoringBreakdown;
  topMatchingChunks?: Array<{
    chunkId: string;
    sectionType?: string;
    crossEncoderScore?: number;
    snippet: string;
  }>;
  totalChunksEvaluated?: number;
}

export interface MatchResult {
  id: string;
  resumeId: string;
  jobId: string;
  bm25Score: number;
  vectorScore: number;
  rrfScore: number;
  crossEncoderScore: number;
  finalScore: number;
  explanation?: MatchExplanation | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueuedJobResponse {
  statusCode: number;
  message: string;
  jobId: string;
  resumeId: string;
  status: 'QUEUED';
}

export interface ImprovementAtsFix {
  hazardCode: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  issue: string;
  recommendation: string;
  priority: number;
}

export interface ContentFinding {
  type: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
  startChar: number;
  endChar: number;
  quote: string;
}

export interface SuggestedRole {
  title: string;
  similarityScore: number;
  matchedSkills: string[];
  missingSkills: string[];
}

export interface LLMExplanation {
  summary: string;
  prioritizedNextSteps: string[];
}

export interface ImprovementsResponse {
  atsScore: number;
  atsFixes: ImprovementAtsFix[];
  contentFindings: ContentFinding[];
  suggestedRoles: SuggestedRole[];
  explanation: LLMExplanation | null;
  llmStatus: 'SUCCESS' | 'UNAVAILABLE';
  provider?: string | null;
  model?: string | null;
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  latencyMs?: number | null;
}

export interface AnalysisStrength {
  claim: string;
  evidence: string;
}

export interface AnalysisImprovement {
  priority: number;
  action: string;
  evidence?: string;
}

export interface StructuredAnalysisData {
  summary: string;
  strengths: Array<AnalysisStrength | string>;
  gaps: Array<{ gap: string; severity?: string; recommendation?: string } | string>;
  prioritized_improvements: Array<AnalysisImprovement | string>;
  match_score: number;
  ats_score: number | null;
  verdict_band: 'strong' | 'medium' | 'weak';
  matched_skills: string[];
  missing_skills: string[];
  partial_skills: string[];
}

export interface AnalysisResult {
  id: string;
  resumeId: string;
  jobId: string;
  status: string;
  llmStatus: 'SUCCESS' | 'UNAVAILABLE' | string;
  score: number;
  result: StructuredAnalysisData;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  latencyMs?: number | null;
  fabricatedEvidenceRate?: number;
  injectionSuspected?: boolean;
  createdAt: string;
  updatedAt: string;
}

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
  source: 'mock' | 'firecrawl';
  isSample: boolean;
  suggestions: ScoredJobSuggestion[];
  message?: string;
}

export interface EvidenceSpan {
  startChar: number;
  endChar: number;
  quote: string;
}

export interface VerifiedRewriteOption {
  text: string;
  evidenceSpans: EvidenceSpan[];
  needsUserInput?: boolean;
}

export interface RewriterResponse {
  status: 'SUCCESS' | 'HALLUCINATION_DETECTED';
  originalBullet: string;
  options: VerifiedRewriteOption[];
  provider?: string | null;
  model?: string | null;
  tokensPrompt?: number;
  tokensCompletion?: number;
  latencyMs?: number;
}

export interface ResumeMatchHistoryItem {
  id: string;
  resumeId: string;
  jobId: string;
  job: {
    id: string;
    title: string;
    company: string;
    location?: string | null;
  };
  matchScore: number;
  subScores: {
    bm25Score?: number | null;
    vectorScore?: number | null;
    rrfScore?: number | null;
    crossEncoderScore?: number | null;
  };
  explanation?: MatchExplanation | null;
  createdAt: string;
  updatedAt: string;
  analysis?: {
    status: string;
    llmStatus?: string | null;
    score?: number | null;
    createdAt?: string;
  } | null;
}

export interface ResumeMatchesListResponse {
  matches: ResumeMatchHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface JobListResponse {
  jobs: JobSummary[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getCsrfTokenFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function getBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return '/api/backend';
  }
  return process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:4000';
}

// ---------------------------------------------------------------------------
// Single-Flight Refresh Queue
// ---------------------------------------------------------------------------

let refreshPromise: Promise<void> | null = null;

export async function singleFlightRefresh(): Promise<void> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const csrf = getCsrfTokenFromCookie();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (csrf) {
        headers['x-csrf-token'] = csrf;
      }

      const res = await fetch(`${getBaseUrl()}/v1/auth/refresh`, {
        method: 'POST',
        headers,
        credentials: 'include',
      });

      if (!res.ok) {
        let errJson: ProblemDetails = {};
        try {
          errJson = await res.json();
        } catch {
          // ignore non-json
        }
        throw new ApiProblemError(res.status, errJson);
      }
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  _isRetry?: boolean;
}

export async function apiClientRequest<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const method = (options.method || 'GET').toUpperCase();
  const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  const headers: Record<string, string> = {};
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  // Attach CSRF token on mutating calls if available
  if (isMutating) {
    const csrfToken = getCsrfTokenFromCookie();
    if (csrfToken) {
      headers['x-csrf-token'] = csrfToken;
    }
  }

  if (options.headers) {
    Object.assign(headers, options.headers);
  }

  const timeoutMs = options.timeoutMs ?? 30000;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      method,
      headers,
      credentials: 'include',
      signal: options.signal || abortController.signal,
    });

    clearTimeout(timeoutId);

    // Handle 401 Unauthorized with single-flight automatic refresh
    const isAuthRoute =
      endpoint.includes('/v1/auth/login') ||
      endpoint.includes('/v1/auth/register') ||
      endpoint.includes('/v1/auth/refresh') ||
      endpoint.includes('/v1/auth/recover');

    if (res.status === 401 && !options._isRetry && !isAuthRoute) {
      try {
        await singleFlightRefresh();
        // Retry the original request exactly once
        return await apiClientRequest<T>(endpoint, {
          ...options,
          _isRetry: true,
        });
      } catch {
        // Refresh failed: fall through to throw original or refresh error
      }
    }

    if (!res.ok) {
      let problem: ProblemDetails = {};
      try {
        problem = await res.json();
      } catch {
        // Response was not JSON
      }

      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

      throw new ApiProblemError(res.status, problem, retryAfter);
    }

    // Handle 204 No Content
    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json()) as T;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof ApiProblemError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ApiProblemError(408, {
        title: 'Request Timeout',
        detail: `The request timed out after ${timeoutMs}ms. Please try again.`,
      });
    }
    throw new ApiProblemError(503, {
      title: 'Network Error',
      detail: err instanceof Error ? err.message : 'Network request failed',
    });
  }
}

// ---------------------------------------------------------------------------
// High-level API Methods
// ---------------------------------------------------------------------------

export const apiClient = {
  // Auth endpoints
  auth: {
    login: (credentials: { username: string; password: string }) =>
      apiClientRequest<AuthSuccessResponse>('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      }),

    register: (data: { username: string; password: string }) =>
      apiClientRequest<AuthSuccessResponse>('/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    refresh: () => singleFlightRefresh(),

    logout: () =>
      apiClientRequest<{ message: string }>('/v1/auth/logout', {
        method: 'POST',
      }),

    getMe: () =>
      apiClientRequest<{ user: UserSummary }>('/v1/auth/me'),

    deleteAccount: (data: { password: string }) =>
      apiClientRequest<{ message: string }>('/v1/account', {
        method: 'DELETE',
        body: JSON.stringify(data),
      }),
  },

  // Usage endpoints
  usage: {
    get: () => apiClientRequest<UserUsageResponse>('/v1/usage'),
  },

  // Resumes endpoints
  resumes: {
    list: () => apiClientRequest<{ resumes: ResumeSummary[] }>('/v1/resumes'),

    get: (id: string) => apiClientRequest<ResumeDetailsResponse>(`/v1/resumes/${id}`),

    requestUploadUrl: (data: UploadUrlRequest) =>
      apiClientRequest<UploadUrlResponse>('/v1/resumes/upload-url', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    completeUpload: (id: string, body?: { sha256?: string }) =>
      apiClientRequest<CompleteUploadResponse>(`/v1/resumes/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
      }),

    delete: (id: string) =>
      apiClientRequest<{ statusCode: number; message: string; id: string }>(`/v1/resumes/${id}`, {
        method: 'DELETE',
      }),

    /**
     * Direct presigned upload to object storage (MinIO/R2).
     * Bypasses Fastify backend, includes progress callbacks and cancel support.
     */
    uploadToStorage: (
      uploadUrl: string,
      file: File,
      headers: Record<string, string>,
      onProgress?: (percent: number) => void,
      onCancelRef?: { current: (() => void) | null }
    ): Promise<void> => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        if (onCancelRef) {
          onCancelRef.current = () => {
            xhr.abort();
            reject(new ApiProblemError(499, { title: 'Upload Cancelled', detail: 'Upload was cancelled by the user.' }));
          };
        }

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable && onProgress) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(
              new ApiProblemError(xhr.status, {
                title: 'Storage Upload Failed',
                detail: `Direct storage upload failed with status ${xhr.status}`,
              })
            );
          }
        });

        xhr.addEventListener('error', () => {
          reject(
            new ApiProblemError(503, {
              title: 'Storage Network Error',
              detail: 'Storage network connection failed during upload',
            })
          );
        });

        xhr.addEventListener('timeout', () => {
          reject(
            new ApiProblemError(408, {
              title: 'Storage Timeout',
              detail: 'Storage upload timed out',
            })
          );
        });

        xhr.addEventListener('abort', () => {
          reject(
            new ApiProblemError(499, {
              title: 'Upload Cancelled',
              detail: 'Upload cancelled',
            })
          );
        });

        xhr.open('PUT', uploadUrl);
        for (const [k, v] of Object.entries(headers)) {
          xhr.setRequestHeader(k, v);
        }
        xhr.timeout = 5 * 60 * 1000;
        xhr.send(file);
      });
    },

    getImprovements: (resumeId: string) =>
      apiClientRequest<ImprovementsResponse>(`/v1/resumes/${resumeId}/improvements`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),

    getSuggestions: (
      resumeId: string,
      params?: { limit?: number; location?: string; seniority?: string; jobId?: string }
    ) =>
      apiClientRequest<JobSuggestionsResponse>(`/v1/resumes/${resumeId}/suggestions`, {
        method: 'POST',
        body: JSON.stringify(params || {}),
      }),

    getMatches: (resumeId: string, params?: { limit?: number; offset?: number }) => {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.offset) q.set('offset', String(params.offset));
      const qs = q.toString() ? `?${q.toString()}` : '';
      return apiClientRequest<ResumeMatchesListResponse>(`/v1/resumes/${resumeId}/matches${qs}`);
    },
  },

  jobs: {
    list: (params?: { limit?: number; offset?: number }) => {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.offset) q.set('offset', String(params.offset));
      const qs = q.toString() ? `?${q.toString()}` : '';
      return apiClientRequest<JobListResponse>(`/v1/jobs${qs}`);
    },

    create: (data: CreateJobRequest) =>
      apiClientRequest<JobSummary>('/v1/jobs', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    get: (id: string) =>
      apiClientRequest<JobDetails>(`/v1/jobs/${id}`),

    match: (jobId: string, resumeId: string) =>
      apiClientRequest<QueuedJobResponse>(`/v1/jobs/${jobId}/match`, {
        method: 'POST',
        body: JSON.stringify({ resumeId }),
      }),

    getMatch: (jobId: string, resumeId: string) =>
      apiClientRequest<MatchResult>(`/v1/jobs/${jobId}/matches/${resumeId}`),

    createAnalysis: (jobId: string, resumeId: string) =>
      apiClientRequest<QueuedJobResponse>(`/v1/jobs/${jobId}/analysis`, {
        method: 'POST',
        body: JSON.stringify({ resumeId }),
      }),

    getAnalysis: (jobId: string, resumeId: string) =>
      apiClientRequest<AnalysisResult>(`/v1/jobs/${jobId}/analysis/${resumeId}`),
  },

  rewriter: {
    rewriteBullet: (params: {
      resumeId: string;
      originalBullet: string;
      targetSkill?: string;
      jobId?: string;
    }) =>
      apiClientRequest<RewriterResponse>('/v1/rewriter/bullet', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
  },
};
