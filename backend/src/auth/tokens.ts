import crypto from 'crypto';
import type { FastifyReply } from 'fastify';
import { env } from '../config/env.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

export function sha256Hash(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Generates an opaque cryptographically secure 256-bit (32 bytes) random token.
 */
export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generates 10 recovery codes, each with 128 bits entropy (16 random bytes).
 * Formatted as 4 hyphen-separated 4-character hex blocks: xxxx-xxxx-xxxx-xxxx.
 */
export function generateRecoveryCodes(count = 10): { plaintext: string; hash: string }[] {
  const codes: { plaintext: string; hash: string }[] = [];
  for (let i = 0; i < count; i++) {
    const rawBytes = crypto.randomBytes(16).toString('hex'); // 128 bits entropy
    // Format: 4 blocks of 4 chars
    const formatted = `${rawBytes.slice(0, 4)}-${rawBytes.slice(4, 8)}-${rawBytes.slice(8, 12)}-${rawBytes.slice(12, 16)}`;
    const normalized = normalizeRecoveryCode(formatted);
    const hash = sha256Hash(normalized);
    codes.push({ plaintext: formatted, hash });
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/**
 * Generates a random double-submit CSRF token (128-bit).
 */
export function generateCsrfToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isSecureCookie(): boolean {
  return env.COOKIE_SECURE || env.NODE_ENV === 'production';
}

export function setAuthCookies(
  reply: FastifyReply,
  tokens: {
    accessToken?: string;
    refreshToken?: string;
    csrfToken?: string;
  }
): void {
  const secure = isSecureCookie();

  if (tokens.accessToken) {
    reply.setCookie('access_token', tokens.accessToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  if (tokens.refreshToken) {
    reply.setCookie('refresh_token', tokens.refreshToken, {
      path: '/v1/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
  }

  if (tokens.csrfToken) {
    // CSRF cookie must be readable by JavaScript to send via X-CSRF-Token header
    reply.setCookie('csrf_token', tokens.csrfToken, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      secure,
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
  }
}

export function clearAuthCookies(reply: FastifyReply): void {
  const secure = isSecureCookie();

  reply.clearCookie('access_token', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
  });

  reply.clearCookie('refresh_token', {
    path: '/v1/auth',
    httpOnly: true,
    sameSite: 'lax',
    secure,
  });

  reply.clearCookie('csrf_token', {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure,
  });
}
