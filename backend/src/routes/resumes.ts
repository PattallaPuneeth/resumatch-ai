import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { handleRequestUploadUrl, handleCompleteUpload } from './resumeController.js';

/**
 * Resume routes — Phase 2B implementation.
 *
 * Implemented endpoints:
 *   POST /v1/resumes/upload-url   → request presigned upload URL
 *   POST /v1/resumes/:id/complete → confirm upload, validate, enqueue parse job
 *
 * Remaining stubs (Phase 2D):
 *   GET    /v1/resumes/:id              → 501
 *   GET    /v1/resumes/:id/download-url → 501
 *   DELETE /v1/resumes/:id             → 501
 *   GET    /v1/resumes                 → 501
 */
export const resumesRoutes: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // Phase 2B: POST /v1/resumes/upload-url
  // -------------------------------------------------------------------------
  app.post(
    '/v1/resumes/upload-url',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
      preHandler: app.authenticate,
    },
    (request: FastifyRequest, reply: FastifyReply) => handleRequestUploadUrl(request, reply)
  );

  // -------------------------------------------------------------------------
  // Phase 2B: POST /v1/resumes/:id/complete
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/resumes/:id/complete',
    {
      preHandler: app.authenticate,
    },
    (request, reply) =>
      handleCompleteUpload(request, reply)
  );

  // -------------------------------------------------------------------------
  // Phase 2D stubs — authenticated, 501 Not Implemented
  // -------------------------------------------------------------------------
  const stub501 = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      statusCode: 501,
      error: 'Not Implemented',
      message: 'This endpoint is not yet implemented. Available in Phase 2D.',
    });
  };

  // Legacy non-versioned stubs preserved for Phase 1 contract tests
  app.get('/resumes', stub501);
  app.post('/resumes', stub501);
  app.get('/resumes/:id', stub501);
  app.delete('/resumes/:id', stub501);
  app.all('/resumes/*', stub501);

  // Versioned Phase 2D stubs
  app.get('/v1/resumes', { preHandler: app.authenticate }, stub501);
  app.get('/v1/resumes/:id', { preHandler: app.authenticate }, stub501);
  app.get('/v1/resumes/:id/download-url', { preHandler: app.authenticate }, stub501);
  app.delete('/v1/resumes/:id', { preHandler: app.authenticate }, stub501);
};
