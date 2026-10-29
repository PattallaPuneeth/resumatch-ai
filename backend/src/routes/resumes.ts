import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import {
  handleRequestUploadUrl,
  handleCompleteUpload,
  handleGetResume,
  handleGetDownloadUrl,
  handleDeleteResume,
  handleListResumes,
  uploadUrlBodySchema,
} from './resumeController.js';
import { scaledRateLimit } from '../config/env.js';
import { asOpenApiSchema } from '../plugins/swagger.js';

/**
 * Resume routes — Phase 2B & 2D implementation.
 *
 * Implemented endpoints:
 *   POST   /v1/resumes/upload-url        → request presigned upload URL (Phase 2B)
 *   POST   /v1/resumes/:id/complete      → confirm upload, validate, enqueue parse job (Phase 2B)
 *   GET    /v1/resumes                   → list authenticated user's resumes (Phase 2D)
 *   GET    /v1/resumes/:id               → retrieve resume status and parsed result (Phase 2D)
 *   GET    /v1/resumes/:id/download-url  → get short-lived presigned download URL (Phase 2D)
 *   DELETE /v1/resumes/:id               → delete resume, storage object, derived data & write audit log (Phase 2D)
 *
 * Legacy unversioned stubs (Phase 1):
 *   GET/POST/DELETE /resumes*            → 501
 */
export const resumesRoutes: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // Phase 2B: POST /v1/resumes/upload-url
  // -------------------------------------------------------------------------
  app.post(
    '/v1/resumes/upload-url',
    {
      schema: {
        tags: ['Resumes'],
        summary: 'Request presigned S3 upload URL for resume document',
        body: asOpenApiSchema(uploadUrlBodySchema),
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      config: {
        rateLimit: {
          max: scaledRateLimit(10),
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
      schema: {
        tags: ['Resumes'],
        summary: 'Confirm upload completion, validate magic bytes, and enqueue parse job',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      preHandler: app.authenticate,
    },
    (request, reply) => handleCompleteUpload(request, reply)
  );

  // -------------------------------------------------------------------------
  // Phase 2D: GET /v1/resumes (List user's resumes)
  // -------------------------------------------------------------------------
  app.get(
    '/v1/resumes',
    {
      schema: {
        tags: ['Resumes'],
        summary: 'List authenticated user resumes',
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      preHandler: app.authenticate,
    },
    (request, reply) => handleListResumes(request, reply)
  );

  // -------------------------------------------------------------------------
  // Phase 2D: GET /v1/resumes/:id (Get single resume with parsed text & entities)
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/resumes/:id',
    {
      schema: {
        tags: ['Resumes'],
        summary: 'Retrieve resume status and parsed content',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      preHandler: app.authenticate,
    },
    (request, reply) => handleGetResume(request, reply)
  );

  // -------------------------------------------------------------------------
  // Phase 2D: GET /v1/resumes/:id/download-url (Get presigned download URL)
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/resumes/:id/download-url',
    {
      schema: {
        tags: ['Resumes'],
        summary: 'Get short-lived presigned download URL for resume file',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      preHandler: app.authenticate,
    },
    (request, reply) => handleGetDownloadUrl(request, reply)
  );

  // -------------------------------------------------------------------------
  // Phase 2D: DELETE /v1/resumes/:id (Delete resume and derived resources)
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/v1/resumes/:id',
    {
      schema: {
        tags: ['Resumes'],
        summary: 'Delete resume, object storage file, and derived analysis data',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
      preHandler: app.authenticate,
    },
    (request, reply) => handleDeleteResume(request, reply)
  );

  // -------------------------------------------------------------------------
  // Legacy non-versioned stubs preserved for Phase 1 contract tests
  // -------------------------------------------------------------------------
  const stub501 = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      statusCode: 501,
      error: 'Not Implemented',
      message: 'This endpoint is not yet implemented. Available in Phase 2D.',
    });
  };

  app.get('/resumes', stub501);
  app.post('/resumes', stub501);
  app.get('/resumes/:id', stub501);
  app.delete('/resumes/:id', stub501);
  app.all('/resumes/*', stub501);
};
