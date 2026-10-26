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
  },
};
