// Shared k6 configuration (Phase 10B). Every value can be overridden with -e NAME=value.

export const BASE_URL = __ENV.BASE_URL || 'http://backend:4000';

// Presigned URLs are signed for the browser-facing S3 host (S3_PUBLIC_ENDPOINT). Inside the
// Docker network that host isn't reachable, so k6 sends the PUT to S3_REWRITE_TO while keeping
// the signed Host header, which leaves the SigV4 signature valid.
export const S3_REWRITE_FROM = __ENV.S3_REWRITE_FROM || 'http://localhost:9000';
export const S3_REWRITE_TO = __ENV.S3_REWRITE_TO || 'http://minio:9000';

export const USERS = parseInt(__ENV.USERS || '20', 10);
export const POLL_INTERVAL_S = parseFloat(__ENV.POLL_INTERVAL_S || '0.5');
export const POLL_TIMEOUT_S = parseFloat(__ENV.POLL_TIMEOUT_S || '90');

// Access tokens live 15 minutes; re-login a little earlier.
export const TOKEN_REFRESH_MS = 12 * 60 * 1000;
