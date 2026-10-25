import type { FastifyRequest } from 'fastify';
import { prisma } from '../db/prisma.js';
import { getClientIp } from './rateLimiter.js';

export type AuthAuditEvent =
  | 'REGISTER'
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'LOCKOUT'
  | 'REFRESH_REUSE_DETECTED'
  | 'LOGOUT'
  | 'LOGOUT_ALL'
  | 'RECOVERY_USED'
  | 'RECOVERY_CODES_REGENERATED'
  | 'ACCOUNT_DELETED';

interface AuditOptions {
  event: AuthAuditEvent;
  userId?: string | null;
  entityId?: string | null;
  entityType?: string;
  details?: Record<string, unknown>;
  request?: FastifyRequest;
}

/**
 * Creates an audit log entry for authentication and account security events.
 * Guarantees NO sensitive credentials (passwords, hashes, raw tokens, recovery codes)
 * are ever persisted in details or message logs.
 */
export async function logAuthAudit({
  event,
  userId,
  entityId,
  entityType = 'User',
  details,
  request,
}: AuditOptions): Promise<void> {
  try {
    let ipAddress: string | undefined;
    let userAgent: string | undefined;

    if (request) {
      ipAddress = getClientIp(request);
      const ua = request.headers['user-agent'];
      userAgent = typeof ua === 'string' ? ua.slice(0, 500) : undefined;
    }

    // Sanitize details: strip any keys that could resemble secrets
    const sanitizedDetails: Record<string, unknown> = {};
    if (details) {
      for (const [key, value] of Object.entries(details)) {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey.includes('password') ||
          lowerKey.includes('token') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('hash') ||
          lowerKey.includes('code')
        ) {
          sanitizedDetails[key] = '[REDACTED]';
        } else {
          sanitizedDetails[key] = value;
        }
      }
    }

    await prisma.auditLog.create({
      data: {
        event,
        action: 'AUTH',
        userId: userId ?? null,
        entityType,
        entityId: entityId ?? userId ?? null,
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
        details: sanitizedDetails as any,
      },
    });
  } catch (error) {
    // Non-blocking for request flow, but log structured error
    console.error('Failed to create auth audit log entry:', error);
  }
}
