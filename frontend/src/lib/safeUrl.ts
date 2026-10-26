/**
 * Safe URL validation for external job listing links.
 * 
 * Enforces:
 * - Only http: and https: protocols allowed (blocks javascript:, data:, file:, vbscript:, etc.)
 * - Safe URL parsing without throwing
 * - Extracts clean hostname for display
 * - Returns inert fallback when unsafe or malformed
 */
export interface ValidatedUrl {
  isValid: boolean;
  safeUrl: string;
  hostname: string;
}

export function validateExternalUrl(rawUrl: string | undefined | null): ValidatedUrl {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { isValid: false, safeUrl: '#', hostname: 'unknown' };
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { isValid: false, safeUrl: '#', hostname: 'unknown' };
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();

    if (protocol !== 'http:' && protocol !== 'https:') {
      return { isValid: false, safeUrl: '#', hostname: 'invalid-protocol' };
    }

    return {
      isValid: true,
      safeUrl: parsed.href,
      hostname: parsed.hostname,
    };
  } catch {
    return { isValid: false, safeUrl: '#', hostname: 'malformed-url' };
  }
}
