import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../db/prisma.js';
import {
  hashPassword,
  verifyPassword,
  dummyArgon2Verify,
  validatePasswordPolicy,
  validateUsernamePolicy,
} from '../auth/password.js';
import {
  generateOpaqueToken,
  generateRecoveryCodes,
  generateCsrfToken,
  normalizeRecoveryCode,
  sha256Hash,
  setAuthCookies,
  clearAuthCookies,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../auth/tokens.js';
import {
  authRateLimitHook,
  checkAccountLockout,
  recordFailedLogin,
  recordSuccessfulLogin,
  getClientIp,
} from '../auth/rateLimiter.js';
import { logAuthAudit } from '../auth/audit.js';
import { deleteStorageObject } from '../storage/s3.js';

// Schemas
const RegisterBodySchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

const LoginBodySchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

const RefreshBodySchema = z
  .object({
    refreshToken: z.string().optional(),
  })
  .optional();

const RecoverBodySchema = z.object({
  username: z.string().min(1, 'Username is required'),
  recoveryCode: z.string().min(1, 'Recovery code is required'),
  newPassword: z.string().min(1, 'New password is required'),
});

const RegenerateRecoveryCodesSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

const DeleteAccountBodySchema = z.object({
  password: z.string().min(1, 'Password confirmation is required'),
});

// Small body size limit (16 KB) for all auth routes
const SMALL_BODY_LIMIT = 16384;

function sendProblemJson(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
  instance: string
) {
  return reply
    .status(status)
    .header('Content-Type', 'application/problem+json; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Pragma', 'no-cache')
    .send({
      type: `https://httpstatuses.com/${status}`,
      title,
      status,
      detail,
      instance,
      statusCode: status,
      error: title,
      message: detail,
    });
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Add no-store cache control to all auth route responses
  app.addHook('onSend', async (_request, reply, _payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
  });

  // ---------------------------------------------------------------------------
  // POST /v1/auth/register
  // ---------------------------------------------------------------------------
  app.post(
    '/v1/auth/register',
    {
      bodyLimit: SMALL_BODY_LIMIT,
      preHandler: authRateLimitHook,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = RegisterBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return sendProblemJson(
          reply,
          400,
          'Bad Request',
          'Validation failed: ' + parseResult.error.issues.map((i) => i.message).join(', '),
          request.url
        );
      }

      const { username, password } = parseResult.data;

      // Validate username policy
      const usernameCheck = validateUsernamePolicy(username);
      if (!usernameCheck.valid) {
        return sendProblemJson(
          reply,
          400,
          'Bad Request',
          usernameCheck.error || 'Invalid username',
          request.url
        );
      }

      // Validate password policy
      const passwordCheck = validatePasswordPolicy(password, username);
      if (!passwordCheck.valid) {
        return sendProblemJson(
          reply,
          400,
          'Bad Request',
          passwordCheck.error || 'Invalid password',
          request.url
        );
      }

      const usernameLower = username.toLowerCase();

      // Check if username already exists
      const existing = await prisma.credential.findUnique({
        where: { usernameLower },
      });
      if (existing) {
        return sendProblemJson(
          reply,
          409,
          'Conflict',
          'Username is already taken.',
          request.url
        );
      }

      // Hash password using Argon2id
      const passwordHash = await hashPassword(password);

      // Generate 10 recovery codes
      const recoveryCodes = generateRecoveryCodes(10);

      // Session family initialization
      const familyId = crypto.randomUUID();
      const rawRefreshToken = generateOpaqueToken();
      const tokenHash = sha256Hash(rawRefreshToken);
      const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
      const ipAddress = getClientIp(request);
      const userAgent = typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent'].slice(0, 500)
        : null;

      // Atomically create User, Credential, RecoveryCodes, and initial Session
      const { user, session } = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            role: 'CANDIDATE',
          },
        });

        await tx.credential.create({
          data: {
            userId: newUser.id,
            username: username.trim(),
            usernameLower,
            passwordHash,
          },
        });

        await tx.recoveryCode.createMany({
          data: recoveryCodes.map((c) => ({
            userId: newUser.id,
            codeHash: c.hash,
          })),
        });

        const newSession = await tx.session.create({
          data: {
            familyId,
            userId: newUser.id,
            tokenHash,
            expiresAt: refreshExpiresAt,
            ipAddress,
            userAgent,
          },
        });

        return { user: newUser, session: newSession };
      });

      // Mint JWT access token
      const accessToken = app.jwt.sign(
        {
          sub: user.id,
          sid: session.id,
          username: username.trim(),
        },
        { expiresIn: '15m' }
      );

      const csrfToken = generateCsrfToken();
      setAuthCookies(reply, {
        accessToken,
        refreshToken: rawRefreshToken,
        csrfToken,
      });

      await logAuthAudit({
        event: 'REGISTER',
        userId: user.id,
        details: { username: username.trim() },
        request,
      });

      return reply.status(201).send({
        user: {
          id: user.id,
          username: username.trim(),
          createdAt: user.createdAt,
        },
        tokens: {
          accessToken,
          refreshToken: rawRefreshToken,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        },
        recoveryCodes: recoveryCodes.map((c) => c.plaintext),
      });
    }
  );

  // ---------------------------------------------------------------------------
  // POST /v1/auth/login
  // ---------------------------------------------------------------------------
  app.post(
    '/v1/auth/login',
    {
      bodyLimit: SMALL_BODY_LIMIT,
      preHandler: authRateLimitHook,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = LoginBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return sendProblemJson(
          reply,
          400,
          'Bad Request',
          'Validation failed: ' + parseResult.error.issues.map((i) => i.message).join(', '),
          request.url
        );
      }

      const { username, password } = parseResult.data;
      const usernameLower = username.trim().toLowerCase();

      // Check lockout first (keyed by usernameLower whether user exists or not)
      const lockout = await checkAccountLockout(usernameLower);
      if (lockout.locked) {
        const retryAfter = lockout.retryAfter ?? 60;
        reply.header('Retry-After', String(retryAfter));
        return sendProblemJson(
          reply,
          429,
          'Too Many Requests',
          `Account temporarily locked due to multiple failed login attempts. Retry in ${retryAfter} seconds.`,
          request.url
        );
      }

      const credential = await prisma.credential.findUnique({
        where: { usernameLower },
        include: { user: true },
      });

      // Generic authentication failure response
      const sendInvalidCredentials = async (actualUserId?: string) => {
        const lockResult = await recordFailedLogin(usernameLower);
        await logAuthAudit({
          event: 'LOGIN_FAILURE',
          userId: actualUserId || null,
          details: { usernameLower, failedAttempts: lockResult.failedAttempts },
          request,
        });

        if (lockResult.locked) {
          await logAuthAudit({
            event: 'LOCKOUT',
            userId: actualUserId || null,
            details: { usernameLower, lockoutSeconds: lockResult.lockoutSeconds },
            request,
          });
        }

        return sendProblemJson(
          reply,
          401,
          'Unauthorized',
          'Invalid username or password.',
          request.url
        );
      };

      if (!credential) {
        // Equalize timing by executing dummy Argon2id verification
        await dummyArgon2Verify(password);
        return sendInvalidCredentials();
      }

      const isValidPassword = await verifyPassword(credential.passwordHash, password);
      if (!isValidPassword) {
        return sendInvalidCredentials(credential.userId);
      }

      // Successful login: reset failed counters and lockout
      await recordSuccessfulLogin(usernameLower);

      // Session fixation defense: Every login creates a NEW session family
      const familyId = crypto.randomUUID();
      const rawRefreshToken = generateOpaqueToken();
      const tokenHash = sha256Hash(rawRefreshToken);
      const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
      const ipAddress = getClientIp(request);
      const userAgent = typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent'].slice(0, 500)
        : null;

      const session = await prisma.session.create({
        data: {
          familyId,
          userId: credential.userId,
          tokenHash,
          expiresAt: refreshExpiresAt,
          ipAddress,
          userAgent,
        },
      });

      const accessToken = app.jwt.sign(
        {
          sub: credential.userId,
          sid: session.id,
          username: credential.username,
        },
        { expiresIn: '15m' }
      );

      const csrfToken = generateCsrfToken();
      setAuthCookies(reply, {
        accessToken,
        refreshToken: rawRefreshToken,
        csrfToken,
      });

      await logAuthAudit({
        event: 'LOGIN_SUCCESS',
        userId: credential.userId,
        details: { username: credential.username },
        request,
      });

      return reply.status(200).send({
        user: {
          id: credential.userId,
          username: credential.username,
        },
        tokens: {
          accessToken,
          refreshToken: rawRefreshToken,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        },
      });
    }
  );

  // ---------------------------------------------------------------------------
  // POST /v1/auth/refresh
  // ---------------------------------------------------------------------------
  app.post(
    '/v1/auth/refresh',
    {
      bodyLimit: SMALL_BODY_LIMIT,
      preHandler: authRateLimitHook,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = RefreshBodySchema.safeParse(request.body);
      const bodyToken = parseResult.success ? parseResult.data?.refreshToken : undefined;
      const cookieToken = request.cookies?.refresh_token;

      const rawRefreshToken = bodyToken || cookieToken;
      if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
        return sendProblemJson(
          reply,
          401,
          'Unauthorized',
          'Refresh token is required.',
          request.url
        );
      }

      const tokenHash = sha256Hash(rawRefreshToken.trim());
      const session = await prisma.session.findUnique({
        where: { tokenHash },
      });

      if (!session) {
        return sendProblemJson(
          reply,
          401,
          'Unauthorized',
          'Invalid refresh token.',
          request.url
        );
      }

      // Replay Detection: If token was already used or revoked, revoke ENTIRE family
      if (session.usedAt !== null || session.revokedAt !== null) {
        await prisma.session.updateMany({
          where: {
            familyId: session.familyId,
            revokedAt: null,
          },
          data: {
            revokedAt: new Date(),
          },
        });

        clearAuthCookies(reply);

        await logAuthAudit({
          event: 'REFRESH_REUSE_DETECTED',
          userId: session.userId,
          details: { familyId: session.familyId },
          request,
        });

        return sendProblemJson(
          reply,
          401,
          'Unauthorized',
          'Refresh token reuse detected. All sessions in family have been revoked.',
          request.url
        );
      }

      // Expiry Check
      if (new Date() > session.expiresAt) {
        await prisma.session.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        });
        clearAuthCookies(reply);
        return sendProblemJson(
          reply,
          401,
          'Unauthorized',
          'Refresh token has expired.',
          request.url
        );
      }

      // Rotate: Mark current session as used and create next session in same family
      const nextRawRefreshToken = generateOpaqueToken();
      const nextTokenHash = sha256Hash(nextRawRefreshToken);
      const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
      const ipAddress = getClientIp(request);
      const userAgent = typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent'].slice(0, 500)
        : null;

      const [, nextSession, credential] = await prisma.$transaction([
        prisma.session.update({
          where: { id: session.id },
          data: { usedAt: new Date() },
        }),
        prisma.session.create({
          data: {
            familyId: session.familyId,
            userId: session.userId,
            tokenHash: nextTokenHash,
            expiresAt: refreshExpiresAt,
            ipAddress,
            userAgent,
          },
        }),
        prisma.credential.findUnique({
          where: { userId: session.userId },
        }),
      ]);

      const username = credential?.username || '';
      const accessToken = app.jwt.sign(
        {
          sub: session.userId,
          sid: nextSession.id,
          username,
        },
        { expiresIn: '15m' }
      );

      const csrfToken = generateCsrfToken();
      setAuthCookies(reply, {
        accessToken,
        refreshToken: nextRawRefreshToken,
        csrfToken,
      });

      return reply.status(200).send({
        tokens: {
          accessToken,
          refreshToken: nextRawRefreshToken,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        },
      });
    }
  );

  // ---------------------------------------------------------------------------
  // POST /v1/auth/logout
  // ---------------------------------------------------------------------------
  app.post(
    '/v1/auth/logout',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const sessionId = request.session?.id;
      if (sessionId) {
        await prisma.session.updateMany({
          where: { id: sessionId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      clearAuthCookies(reply);

      await logAuthAudit({
        event: 'LOGOUT',
        userId: request.user.sub,
        details: { sessionId },
        request,
      });

      return reply.status(200).send({
        message: 'Successfully logged out.',
      });
    }
  );

  // ---------------------------------------------------------------------------
  // POST /v1/auth/logout-all
  // ---------------------------------------------------------------------------
  app.post(
    '/v1/auth/logout-all',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user.sub;
      await prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      clearAuthCookies(reply);

      await logAuthAudit({
        event: 'LOGOUT_ALL',
        userId,
        request,
      });

      return reply.status(200).send({
        message: 'All active sessions have been revoked.',
      });
    }
  );

  // ---------------------------------------------------------------------------
  // GET /v1/auth/me
  // ---------------------------------------------------------------------------
  app.get(
    '/v1/auth/me',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user.sub;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { credential: true },
      });

      if (!user) {
        return sendProblemJson(
          reply,
          404,
          'Not Found',
          'User not found.',
          request.url
        );
      }

      return reply.status(200).send({
        user: {
          id: user.id,
          username: user.credential?.username || '',
          email: user.email || null,
          role: user.role,
          createdAt: user.createdAt,
        },
      });
    }
  );

  // ---------------------------------------------------------------------------
  // POST /v1/auth/recover
  // ---------------------------------------------------------------------------
  app.post(
    '/v1/auth/recover',
    {
      bodyLimit: SMALL_BODY_LIMIT,
      preHandler: authRateLimitHook,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = RecoverBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return sendProblemJson(
          reply,
          400,
          'Bad Request',
          'Validation failed: ' + parseResult.error.issues.map((i) => i.message).join(', '),
          request.url
        );
      }

      const { username, recoveryCode, newPassword } = parseResult.data;
      const usernameLower = username.trim().toLowerCase();

      // Check account lockout
      const lockout = await checkAccountLockout(usernameLower);
      if (lockout.locked) {
        const retryAfter = lockout.retryAfter ?? 60;
        reply.header('Retry-After', String(retryAfter));
        return sendProblemJson(
          reply,
          429,
          'Too Many Requests',
          `Account temporarily locked due to multiple failed attempts. Retry in ${retryAfter} seconds.`,
          request.url
        );
      }

      const credential = await prisma.credential.findUnique({
        where: { usernameLower },
      });

      const sendGenericRecoveryError = async () => {
        await dummyArgon2Verify(newPassword);
        const lockResult = await recordFailedLogin(usernameLower);
        await logAuthAudit({
          event: 'LOGIN_FAILURE',
          userId: credential?.userId || null,
          details: { reason: 'recovery_failed', usernameLower, failedAttempts: lockResult.failedAttempts },
          request,
        });

        return sendProblemJson(
          reply,
          401,
          'Unauthorized',
          'Invalid recovery credentials.',
          request.url
        );
      };

      if (!credential) {
        return sendGenericRecoveryError();
      }

      // Check recovery code
      const normalizedCode = normalizeRecoveryCode(recoveryCode);
      const codeHash = sha256Hash(normalizedCode);

      const validCode = await prisma.recoveryCode.findFirst({
        where: {
          userId: credential.userId,
          codeHash,
          usedAt: null,
        },
      });

      if (!validCode) {
        return sendGenericRecoveryError();
      }

      // Validate new password policy
      const passwordCheck = validatePasswordPolicy(newPassword, credential.username);
      if (!passwordCheck.valid) {
        return sendProblemJson(
          reply,
          400,
          'Bad Request',
          passwordCheck.error || 'Invalid new password',
          request.url
        );
      }

      const newPasswordHash = await hashPassword(newPassword);

      // Invalidate recovery code, update password, and revoke ALL existing sessions
      await prisma.$transaction([
        prisma.recoveryCode.update({
          where: { id: validCode.id },
          data: { usedAt: new Date() },
        }),
        prisma.credential.update({
          where: { id: credential.id },
          data: { passwordHash: newPasswordHash },
        }),
        prisma.session.updateMany({
          where: { userId: credential.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);

      // Reset login lockout counter
      await recordSuccessfulLogin(usernameLower);
      clearAuthCookies(reply);

      await logAuthAudit({
        event: 'RECOVERY_USED',
        userId: credential.userId,
        request,
      });

      return reply.status(200).send({
        message: 'Password has been reset successfully. Please log in with your new password.',
      });
    }
  );

  // ---------------------------------------------------------------------------
  // POST /v1/auth/recovery-codes/regenerate
  // ---------------------------------------------------------------------------
  app.post(
    '/v1/auth/recovery-codes/regenerate',
    {
      bodyLimit: SMALL_BODY_LIMIT,
      preHandler: [authRateLimitHook, app.authenticate],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = RegenerateRecoveryCodesSchema.safeParse(request.body);
      if (!parseResult.success) {
        return sendProblemJson(
          reply,
          400,
          'Bad Request',
          'Password confirmation is required to regenerate recovery codes.',
          request.url
        );
      }

      const { password } = parseResult.data;
      const userId = request.user.sub;

      const credential = await prisma.credential.findUnique({
        where: { userId },
      });

      if (!credential) {
        return sendProblemJson(reply, 401, 'Unauthorized', 'User credential not found.', request.url);
      }

      const isPasswordValid = await verifyPassword(credential.passwordHash, password);
      if (!isPasswordValid) {
        return sendProblemJson(reply, 401, 'Unauthorized', 'Incorrect password.', request.url);
      }

      const newCodes = generateRecoveryCodes(10);

      await prisma.$transaction([
        // Invalidate all past recovery codes
        prisma.recoveryCode.deleteMany({
          where: { userId },
        }),
        // Insert 10 freshly generated recovery codes
        prisma.recoveryCode.createMany({
          data: newCodes.map((c) => ({
            userId,
            codeHash: c.hash,
          })),
        }),
      ]);

      await logAuthAudit({
        event: 'RECOVERY_CODES_REGENERATED',
        userId,
        request,
      });

      return reply.status(200).send({
        recoveryCodes: newCodes.map((c) => c.plaintext),
      });
    }
  );

  // ---------------------------------------------------------------------------
  // DELETE /v1/account (Cascade deletion + audit log)
  // ---------------------------------------------------------------------------
  app.delete(
    '/v1/account',
    {
      bodyLimit: SMALL_BODY_LIMIT,
      preHandler: [authRateLimitHook, app.authenticate],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = DeleteAccountBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return sendProblemJson(
          reply,
          400,
          'Bad Request',
          'Password confirmation is required to delete your account.',
          request.url
        );
      }

      const { password } = parseResult.data;
      const userId = request.user.sub;

      const credential = await prisma.credential.findUnique({
        where: { userId },
      });

      if (!credential) {
        return sendProblemJson(reply, 401, 'Unauthorized', 'Account credentials not found.', request.url);
      }

      const isPasswordValid = await verifyPassword(credential.passwordHash, password);
      if (!isPasswordValid) {
        return sendProblemJson(
          reply,
          401,
          'Unauthorized',
          'Incorrect password confirmation.',
          request.url
        );
      }

      // Step 1: Find all resumes to remove storage objects from S3
      const resumes = await prisma.resume.findMany({
        where: { userId },
        select: { id: true, storageKey: true },
      });

      for (const resume of resumes) {
        try {
          await deleteStorageObject(resume.storageKey);
        } catch (err) {
          request.log.warn({ err, storageKey: resume.storageKey }, 'Failed to delete S3 storage object during account deletion');
        }
      }

      // Step 2: Atomic database cleanup
      await prisma.$transaction(async (tx) => {
        // Delete all jobs created by user
        await tx.job.deleteMany({
          where: { userId },
        });

        // Delete user (Prisma onDelete: Cascade removes resumes, parsed data, chunks, credentials, sessions, recovery codes)
        await tx.user.delete({
          where: { id: userId },
        });
      });

      // Step 3: Write audit log (AuditLog has NO foreign key to User so it persists)
      await logAuthAudit({
        event: 'ACCOUNT_DELETED',
        userId,
        entityType: 'Account',
        entityId: userId,
        request,
      });

      clearAuthCookies(reply);

      return reply.status(200).send({
        message: 'Account successfully deleted.',
      });
    }
  );
};
