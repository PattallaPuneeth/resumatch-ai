import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db/prisma.js';
import { hashPassword } from '../auth/password.js';
import {
  generateOpaqueToken,
  generateCsrfToken,
  sha256Hash,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../auth/tokens.js';

export interface TestAuthSession {
  user: {
    id: string;
    username: string;
    email?: string | null;
    role: string;
  };
  userId: string;
  sessionId: string;
  familyId: string;
  accessToken: string;
  authHeader: { authorization: string };
  refreshToken: string;
  csrfToken: string;
  cookies: {
    access_token: string;
    refresh_token: string;
    csrf_token: string;
  };
  cookieHeader: string;
}

export async function createTestUserAndSession(
  app: FastifyInstance,
  options: {
    username?: string;
    email?: string;
    role?: string;
    password?: string;
  } = {}
): Promise<TestAuthSession> {
  const uniqueSuffix = crypto.randomUUID().slice(0, 8);
  const username = options.username || `testuser_${uniqueSuffix}`;
  const usernameLower = username.toLowerCase();
  const password = options.password || 'SecurePassword123!';
  const role = options.role || 'CANDIDATE';

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      email: options.email ? options.email.toLowerCase() : null,
      role,
      credential: {
        create: {
          username,
          usernameLower,
          passwordHash,
        },
      },
    },
    include: {
      credential: true,
    },
  });

  const familyId = crypto.randomUUID();
  const rawRefreshToken = generateOpaqueToken();
  const tokenHash = sha256Hash(rawRefreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

  const session = await prisma.session.create({
    data: {
      familyId,
      userId: user.id,
      tokenHash,
      expiresAt,
    },
  });

  const accessToken = app.jwt.sign(
    {
      sub: user.id,
      sid: session.id,
      username,
    },
    { expiresIn: '15m' }
  );

  const csrfToken = generateCsrfToken();

  return {
    user: {
      id: user.id,
      username,
      email: user.email,
      role: user.role,
    },
    userId: user.id,
    sessionId: session.id,
    familyId: session.familyId,
    accessToken,
    authHeader: { authorization: `Bearer ${accessToken}` },
    refreshToken: rawRefreshToken,
    csrfToken,
    cookies: {
      access_token: accessToken,
      refresh_token: rawRefreshToken,
      csrf_token: csrfToken,
    },
    cookieHeader: `access_token=${accessToken}; refresh_token=${rawRefreshToken}; csrf_token=${csrfToken}`,
  };
}

export async function cleanupTestUser(userId: string): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.resume.deleteMany({ where: { userId } }),
      prisma.job.deleteMany({ where: { userId } }),
      prisma.session.deleteMany({ where: { userId } }),
      prisma.recoveryCode.deleteMany({ where: { userId } }),
      prisma.credential.deleteMany({ where: { userId } }),
      prisma.user.deleteMany({ where: { id: userId } }),
    ]);
  } catch {
    // Non-blocking cleanup
  }
}

/**
 * Compatibility helper for live e2e test scripts.
 * Creates an active DB session and returns a signed access token.
 */
export async function generateTestTokenForUser(
  identifier?: string
): Promise<{ userId: string; email?: string | null; token: string }> {
  const { buildServer } = await import('../server.js');
  const app = buildServer();
  await app.ready();

  try {
    let user;
    if (identifier) {
      user = await prisma.user.findFirst({
        where: {
          OR: [{ id: identifier }, { email: identifier }],
        },
        include: { credential: true },
      });
    }

    if (!user) {
      const session = await createTestUserAndSession(app, {
        email: identifier && identifier.includes('@') ? identifier : undefined,
      });
      return {
        userId: session.userId,
        email: session.user.email,
        token: session.accessToken,
      };
    }

    let username = user.credential?.username;
    if (!username) {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      username = `testuser_${uniqueSuffix}`;
      await prisma.credential.create({
        data: {
          userId: user.id,
          username,
          usernameLower: username.toLowerCase(),
          passwordHash: await hashPassword('SecurePassword123!'),
        },
      });
    }

    const familyId = crypto.randomUUID();
    const rawRefreshToken = generateOpaqueToken();
    const tokenHash = sha256Hash(rawRefreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    const session = await prisma.session.create({
      data: {
        familyId,
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    const token = app.jwt.sign(
      {
        sub: user.id,
        sid: session.id,
        username,
      },
      { expiresIn: '15m' }
    );

    return {
      userId: user.id,
      email: user.email,
      token,
    };
  } finally {
    await app.close();
  }
}

export const generateDevToken = generateTestTokenForUser;

