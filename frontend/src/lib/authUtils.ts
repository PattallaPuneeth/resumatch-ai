/**
 * Auth validation and security utilities (Phase 8A)
 */

export interface PolicyCheckResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates username against policy:
 * - 3 to 32 characters
 * - Alphanumeric, underscores, dashes, periods
 */
export function validateUsername(username: string): PolicyCheckResult {
  if (!username || typeof username !== 'string') {
    return { valid: false, error: 'Username is required' };
  }
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 32) {
    return { valid: false, error: 'Username must be between 3 and 32 characters' };
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    return {
      valid: false,
      error: 'Username can only contain letters, numbers, underscores, dashes, and periods',
    };
  }
  return { valid: true };
}

/**
 * Validates password against policy:
 * - 12 to 128 characters
 * - Must not contain username
 */
export function validatePassword(password: string, username?: string): PolicyCheckResult {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }
  if (password.length < 12 || password.length > 128) {
    return { valid: false, error: 'Password must be between 12 and 128 characters' };
  }
  if (username && username.trim().length >= 3) {
    if (password.toLowerCase().includes(username.trim().toLowerCase())) {
      return { valid: false, error: 'Password must not contain the username' };
    }
  }
  return { valid: true };
}

/**
 * Open-redirect defense:
 * Ensures redirect URL is a relative same-origin path:
 * - Must start with a single '/'
 * - Must NOT start with '//' (protocol-relative URL)
 * - Must NOT start with '/\\'
 * - Must NOT contain protocol schemes ('http:', 'https:', 'javascript:', 'data:')
 */
export function sanitizeNextRedirect(rawNext: string | null | undefined, fallback = '/dashboard'): string {
  if (!rawNext || typeof rawNext !== 'string') {
    return fallback;
  }
  const trimmed = rawNext.trim();

  // Reject empty or non-relative paths
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return fallback;
  }

  // Reject paths containing colons before a question mark (e.g. /javascript:alert)
  const pathPart = trimmed.split('?')[0];
  if (pathPart.includes(':')) {
    return fallback;
  }

  return trimmed;
}
