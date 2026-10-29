import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';

export function asOpenApiSchema(zodSchema: z.ZodTypeAny) {
  const jsonSchema = z.toJSONSchema(zodSchema, {
    target: 'openapi-3.0',
    unrepresentable: 'any',
    io: 'input',
  }) as any;
  const { $schema, ...rest } = jsonSchema;
  return rest;
}

const swaggerPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  // Preserve existing controller-level validation and exact 422/400 status codes
  app.setValidatorCompiler(() => () => true);

  await app.register(fastifySwagger, {
    transform: ({ schema, url, route }) => {
      // Unversioned paths (/resumes, /jobs/*, /analyses/*) are legacy stubs that only answer
      // 501/410; they would list every HTTP method in the docs, so they are left out
      if (!url.startsWith('/v1/') && url !== '/health') {
        return { schema: { ...(schema ?? {}), hide: true }, url };
      }
      // Every route behind app.authenticate needs a session; most routes do not repeat
      // `security` themselves, so it is added here and the docs match the code
      const authenticate = (app as unknown as { authenticate?: unknown }).authenticate;
      const guarded = [route.preHandler].flat().includes(authenticate as never);
      if (guarded && !(schema as { security?: unknown } | undefined)?.security) {
        return { schema: { ...(schema ?? {}), security: [{ cookieAuth: [] }, { bearerAuth: [] }] }, url };
      }
      return { schema, url };
    },
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
