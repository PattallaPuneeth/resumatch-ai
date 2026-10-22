export interface ServiceHealth {
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  error?: string;
}

export interface BackendHealthResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  version: string;
  services: {
    postgres: ServiceHealth;
    redis: ServiceHealth;
    minio: ServiceHealth;
  };
}

export interface MLHealthResponse {
  status: string;
  service: string;
  version: string;
  dependencies: {
    postgres: {
      status: string;
      latency_ms?: number;
      pgvector_extension?: string;
      error?: string;
    };
  };
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}

export class ApiException extends Error {
  constructor(
    public statusCode: number,
    public errorName: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiException';
  }
}

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const ML_URL = process.env.NEXT_PUBLIC_ML_URL || 'http://localhost:8000';

async function request<T>(baseUrl: string, endpoint: string, init?: RequestInit): Promise<T> {
  const url = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });

    if (!res.ok) {
      let errorBody: ApiError | null = null;
      try {
        errorBody = await res.json();
      } catch {
        // Response wasn't JSON
      }

      throw new ApiException(
        res.status,
        errorBody?.error || res.statusText,
        errorBody?.message || `Request failed with HTTP status ${res.status}`,
        errorBody?.details
      );
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiException) throw err;
    throw new ApiException(503, 'NetworkError', err instanceof Error ? err.message : 'Network failure');
  }
}

export const api = {
  getBackendHealth: () => request<BackendHealthResponse>(BACKEND_URL, '/health'),
  getMLHealth: () => request<MLHealthResponse>(ML_URL, '/health'),

  // Stubs
  getResumes: () => request<unknown>(BACKEND_URL, '/resumes'),
  getAnalyses: () => request<unknown>(BACKEND_URL, '/analyses'),
  getJobs: () => request<unknown>(BACKEND_URL, '/jobs'),
};
