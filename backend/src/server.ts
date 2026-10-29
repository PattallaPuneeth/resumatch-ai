import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance } from 'fastify';
import { env, scaledRateLimit } from './config/env.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import swaggerPlugin from './plugins/swagger.js';
import { authRoutes } from './routes/auth.js';
import { analysesRoutes } from './routes/analyses.js';
import { healthRoutes } from './routes/health.js';
import { jobsRoutes } from './routes/jobs.js';
import { resumesRoutes } from './routes/resumes.js';
import { rewriterRoutes } from './routes/rewriter.js';
import { improvementsRoutes } from './routes/improvements.js';
import { usageRoutes } from './routes/usage.js';
import { suggestionsRoutes } from './routes/suggestions.js';
import { dlqRoutes } from './routes/dlq.js';
import { eventsRoutes } from './routes/events.js';
import { logJobSourceStatus } from './services/jobSource/factory.js';
import { registerTracingHooks } from './telemetry.js';

export function buildServer(options?: { onRoute?: (routeOptions: any) => void }): FastifyInstance {
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

  if (options?.onRoute) {
    app.addHook('onRoute', options.onRoute);
  }

  // Request spans; no-op unless initTelemetry() turned tracing on
  registerTracingHooks(app);

  // Global Security Headers (C3 - Transport & Headers Hardening)
  app.addHook('onSend', async (_request, reply, _payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), browsing-topics=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    if (env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (!reply.getHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-store, max-age=0');
    }
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
    max: scaledRateLimit(100),
    timeWindow: '1 minute',
  });

  // Session & JWT authentication
  app.register(authPlugin);

  // OpenAPI Documentation (Phase 1 Contract)
  app.register(swaggerPlugin);

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
  app.register(suggestionsRoutes);
  app.register(dlqRoutes);
  app.register(eventsRoutes);

  // Explicitly log active JobSource and reason at startup (non-secret)
  logJobSourceStatus(app.log);

  return app;
}
