import cors from '@fastify/cors';
import Fastify, { FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
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

  // Central Error Handler
  registerErrorHandler(app);

  // Route Registration
  app.register(healthRoutes);
  app.register(resumesRoutes);
  app.register(analysesRoutes);
  app.register(jobsRoutes);

  return app;
}
