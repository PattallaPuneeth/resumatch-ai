import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { analysesRoutes } from './routes/analyses.js';
import { healthRoutes } from './routes/health.js';
import { jobsRoutes } from './routes/jobs.js';
import { resumesRoutes } from './routes/resumes.js';
import { rewriterRoutes } from './routes/rewriter.js';
import { improvementsRoutes } from './routes/improvements.js';
import { usageRoutes } from './routes/usage.js';

export function buildServer(): FastifyInstance {
  const isDev = env.NODE_ENV === 'development';

  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    logger: isDev
      ? {
          level: env.LOG_LEVEL,
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          },
        }
      : {
          level: env.LOG_LEVEL,
        },
  });

  const ALLOWED_ORIGINS = new Set(
    (env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  // Register cookie support before auth plugin
  app.register(cookie);

  // Strict CORS allowlist with credentials
  app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (such as mobile apps, curl, or server-to-server)
      if (!origin) {
        cb(null, true);
        return;
      }
      if (ALLOWED_ORIGINS.has(origin.toLowerCase())) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
  });

  // Support empty JSON body if client sends Content-Type: application/json with empty body
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || (typeof body === 'string' && body.trim() === '')) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Rate limiting (required by spec for upload-url endpoint)
  app.register(rateLimit, {
    global: false, // Only apply to routes that opt in via config.rateLimit
    max: 100,
    timeWindow: '1 minute',
  });

  // Session & JWT authentication
  app.register(authPlugin);

  // Central Error Handler
  registerErrorHandler(app);

  // Route Registration
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(resumesRoutes);
  app.register(analysesRoutes);
  app.register(jobsRoutes);
  app.register(rewriterRoutes);
  app.register(improvementsRoutes);
  app.register(usageRoutes);
  return app;
}
