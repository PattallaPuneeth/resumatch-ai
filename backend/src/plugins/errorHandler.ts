import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export interface StructuredErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
  timestamp: string;
  requestId: string;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    const timestamp = new Date().toISOString();

    if (error instanceof ZodError) {
      const response: StructuredErrorResponse = {
        statusCode: 400,
        error: 'Bad Request',
        message: 'Input validation failed',
        details: error.flatten(),
        timestamp,
        requestId,
      };
      request.log.warn({ err: error, requestId }, 'Validation error occurred');
      return reply.status(400).send(response);
    }

    const fastifyError = error as FastifyError;
    const statusCode = fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 600
      ? fastifyError.statusCode
      : 500;

    const errorName = fastifyError.name || 'InternalServerError';
    const message = statusCode === 500 && process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : fastifyError.message || 'Internal server error';

    const response: StructuredErrorResponse = {
      statusCode,
      error: errorName,
      message,
      timestamp,
      requestId,
    };

    if (statusCode >= 500) {
      request.log.error({ err: error, requestId }, 'Unhandled server error');
    } else {
      request.log.warn({ err: error, requestId }, 'Client error occurred');
    }

    return reply.status(statusCode).send(response);
  });
}
