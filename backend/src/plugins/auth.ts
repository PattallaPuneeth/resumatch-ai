import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { timingSafeEqualString } from '../auth/password.js';

export interface JwtPayload {
  sub: string;       // userId
  sid?: string;      // sessionId (checked against DB for immediate revocation)
  username?: string; // username
  email?: string;
  iat?: number;
  exp?: number;
}

export interface SessionInfo {
  id: string;
  familyId: string;
  userId: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionInfo;
    authType?: 'bearer' | 'cookie';
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function getCorsAllowedOrigins(): Set<string> {
  const raw = env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isPublicRoute(method: string, url: string): boolean {
  if (method.toUpperCase() === 'OPTIONS') {
    return true;
  }
  const rawPath = url.split('?')[0];
  const pathname = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;

  if (method.toUpperCase() === 'GET' && pathname === '/health') {
    return true;
  }
  if (
    method.toUpperCase() === 'POST' &&
    (pathname === '/v1/auth/register' ||
      pathname === '/v1/auth/login' ||
      pathname === '/v1/auth/refresh' ||
      pathname === '/v1/auth/recover')
  ) {
    return true;
  }
  return false;
}

const authPlugin: FastifyPluginAsync = async (app) => {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: '15m',
    },
  });

  const allowedOrigins = getCorsAllowedOrigins();

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    // Idempotent: If already authenticated by the global hook, skip re-verification
    if (request.user) {
      return;
    }
    // RFC 7807 Error helper
    const sendAuthError = (status: number, title: string, detail: string) => {
      return reply
        .status(status)
        .header('Content-Type', 'application/problem+json; charset=utf-8')
        .send({
          type: `https://httpstatuses.com/${status}`,
          title,
          status,
          detail,
          instance: request.url,
          // Backward-compatibility fields
          statusCode: status,
          error: title,
          message: detail,
          timestamp: new Date().toISOString(),
          requestId: request.id,
        });
    };

    // 1. Determine Auth Token & Strategy (Bearer vs Cookie)
    let token: string | undefined;
    let authType: 'bearer' | 'cookie' | undefined;

    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
      authType = 'bearer';
    } else if (request.cookies && typeof request.cookies.access_token === 'string') {
      token = request.cookies.access_token.trim();
      authType = 'cookie';
    }

    if (!token || !authType) {
      return sendAuthError(
        401,
        'Unauthorized',
        'Authentication required. Provide a valid Bearer token or session cookie.'
      );
    }

    request.authType = authType;

    // 2. CSRF Enforcement for Cookie-Authenticated State-Changing Requests
    const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase());
    if (authType === 'cookie' && isStateChanging) {
      // a) Strict Origin / Referer check
      const originHeader = request.headers.origin;
      const refererHeader = request.headers.referer;
      let effectiveOrigin = '';

      if (typeof originHeader === 'string' && originHeader.trim() !== '') {
        effectiveOrigin = originHeader.trim().toLowerCase();
      } else if (typeof refererHeader === 'string' && refererHeader.trim() !== '') {
        try {
          const parsed = new URL(refererHeader);
          effectiveOrigin = parsed.origin.toLowerCase();
        } catch {
          effectiveOrigin = '';
        }
      }

      if (!effectiveOrigin || !allowedOrigins.has(effectiveOrigin)) {
        return sendAuthError(
          403,
          'Forbidden',
          'CSRF protection failed: request origin is missing or untrusted.'
        );
      }

      // b) Double-submit CSRF Token comparison
      const csrfHeader = request.headers['x-csrf-token'];
      const csrfCookie = request.cookies.csrf_token;

      if (
        typeof csrfHeader !== 'string' ||
        typeof csrfCookie !== 'string' ||
        csrfHeader.trim() === '' ||
        csrfCookie.trim() === '' ||
        !timingSafeEqualString(csrfHeader.trim(), csrfCookie.trim())
      ) {
        return sendAuthError(
          403,
          'Forbidden',
          'CSRF protection failed: missing or invalid CSRF token.'
        );
      }
    }

    // 3. JWT Verification
    let payload: JwtPayload;
    try {
      payload = app.jwt.verify<JwtPayload>(token);
    } catch (err: any) {
      request.log.warn({ err }, 'JWT verification failed');
      return sendAuthError(
        401,
        'Unauthorized',
        'Invalid or expired authentication token.'
      );
    }

    if (!payload || typeof payload.sub !== 'string' || payload.sub.trim() === '') {
      return sendAuthError(
        401,
        'Unauthorized',
        'Invalid token payload: missing subject identifier.'
      );
    }

    if (!payload.sid || typeof payload.sid !== 'string' || payload.sid.trim() === '') {
      if (env.NODE_ENV === 'production') {
        return sendAuthError(
          401,
          'Unauthorized',
          'Invalid token payload: missing session identifier.'
        );
      }
    }

    // 4. Session Validation (Revocation takes effect immediately on every request)
    // sid in the access token is checked against the database on each request
    try {
      if (payload.sid && prisma.session?.findUnique) {
        const session = await prisma.session.findUnique({
          where: { id: payload.sid },
          select: {
            id: true,
            familyId: true,
            userId: true,
            revokedAt: true,
            expiresAt: true,
          },
        });

        if (!session) {
          return sendAuthError(
            401,
            'Unauthorized',
            'Session does not exist or has expired.'
          );
        }

        if (session.revokedAt !== null) {
          return sendAuthError(
            401,
            'Unauthorized',
            'Session has been revoked.'
          );
        }

        if (session.userId !== payload.sub) {
          return sendAuthError(
            401,
            'Unauthorized',
            'Session does not match token subject.'
          );
        }

        if (new Date() > session.expiresAt) {
          return sendAuthError(
            401,
            'Unauthorized',
            'Session has expired.'
          );
        }

        request.session = {
          id: session.id,
          familyId: session.familyId,
          userId: session.userId,
        };
      }
    } catch (err) {
      request.log.error({ err }, 'Database error during session lookup');
      return sendAuthError(
        500,
        'Internal Server Error',
        'Database error validating session.'
      );
    }

    // Attach decoded user
    request.user = payload;
  });

  // Global Default-Deny Hook:
  // Every route not in the explicit PUBLIC allowlist requires authentication.
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublicRoute(request.method, request.url)) {
      return;
    }
    await app.authenticate(request, reply);
  });
};

export default fp(authPlugin, { name: 'auth' });
