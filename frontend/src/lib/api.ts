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

// ---------------------------------------------------------------------------
// Phase 2B: Resume upload types
// ---------------------------------------------------------------------------

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
// Base request helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export const api = {
  getBackendHealth: () => request<BackendHealthResponse>(BACKEND_URL, '/health'),
  getMLHealth: () => request<MLHealthResponse>(ML_URL, '/health'),

  // Stubs
  getResumes: () => request<unknown>(BACKEND_URL, '/resumes'),
  getAnalyses: () => request<unknown>(BACKEND_URL, '/analyses'),
  getJobs: () => request<unknown>(BACKEND_URL, '/jobs'),

  // Phase 2B: Upload flow
  requestUploadUrl: (body: UploadUrlRequest, token: string) =>
    request<UploadUrlResponse>(BACKEND_URL, '/v1/resumes/upload-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),

  completeUpload: (resumeId: string, token: string) =>
    request<CompleteUploadResponse>(BACKEND_URL, `/v1/resumes/${resumeId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),

  /**
   * Upload a file directly to object storage using a presigned PUT URL.
   * This does NOT go through the API — it goes directly to MinIO/R2.
   * Must not include Authorization header (presigned URL is self-authenticating).
   */
  uploadToStorage: async (
    uploadUrl: string,
    file: File,
    headers: Record<string, string>,
    onProgress?: (percent: number) => void
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new ApiException(xhr.status, 'StorageError', `Direct upload failed with status ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', () => {
        reject(new ApiException(0, 'NetworkError', 'Direct upload to storage failed due to a network error'));
      });

      xhr.addEventListener('timeout', () => {
        reject(new ApiException(0, 'Timeout', 'Direct upload timed out'));
      });

      xhr.open('PUT', uploadUrl);

      // Set the headers returned by the backend (e.g., Content-Type)
      for (const [key, value] of Object.entries(headers)) {
        xhr.setRequestHeader(key, value);
      }

      xhr.timeout = 5 * 60 * 1000; // 5 min — aligned with presigned URL TTL
      xhr.send(file);
    });
  },
};
