import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import { analysesRoutes } from './routes/analyses.js';
import { healthRoutes } from './routes/health.js';
import { jobsRoutes } from './routes/jobs.js';
import { resumesRoutes } from './routes/resumes.js';

export function buildServer(): FastifyInstance {
  const isDev = env.NODE_ENV === 'development';

  const app = Fastify({
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

  // Plugins
  app.register(cors, {
    origin: true,
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

  // JWT authentication
  app.register(authPlugin);

  // Central Error Handler
  registerErrorHandler(app);

  // Route Registration
  app.register(healthRoutes);
  app.register(resumesRoutes);
  app.register(analysesRoutes);
  app.register(jobsRoutes);

  return app;
}
