import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export function asOpenApiSchema(zodSchema: z.ZodTypeAny) {
  const jsonSchema = zodToJsonSchema(zodSchema, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as any;
  const { $schema, ...rest } = jsonSchema;
  return rest;
}

const swaggerPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  // Preserve existing controller-level validation and exact 422/400 status codes
  app.setValidatorCompiler(() => () => true);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'ResuMatch AI API',
        description: 'Production AI resume matching, extraction and scoring platform API specification',
        version: '1.0.0',
      },
      servers: [
        {
          url: 'http://localhost:4000',
          description: 'Local API server',
        },
      ],
      tags: [
        { name: 'Health', description: 'System health check and readiness' },
        { name: 'Auth', description: 'User registration, sessions, JWT refresh and account recovery' },
        { name: 'Resumes', description: 'Resume presigned uploads, completion, metadata and downloads' },
        { name: 'Jobs', description: 'Job description intake and embeddings' },
        { name: 'Matching', description: 'Hybrid search, cross-encoder reranking, and ATS fit scoring' },
        { name: 'Analysis', description: 'In-depth resume-job gap analysis and scoring breakdown' },
        { name: 'Rewriter', description: 'Bullet point improvement suggestions and rewriting' },
        { name: 'Usage', description: 'Account rate limits and quota consumption metrics' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'access_token',
          },
        },
      },
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    staticCSP: false,
    transformSpecificationClone: true,
  });

  app.get('/openapi.json', { schema: { hide: true } }, async (_req, reply) => {
    return reply.send(app.swagger());
  });
});

export default swaggerPlugin;
