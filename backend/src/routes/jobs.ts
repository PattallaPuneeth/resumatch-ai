import type { FastifyPluginAsync } from 'fastify';

export const jobsRoutes: FastifyPluginAsync = async (app) => {
  const handler = async (_request: unknown, reply: any) => {
    return reply.status(501).send({
      statusCode: 501,
      error: 'Not Implemented',
      message: 'Job descriptions and matching endpoint is not yet implemented. Available in Phase 2.',
    });
  };

  app.get('/jobs', handler);
  app.post('/jobs', handler);
  app.get('/jobs/:id', handler);
  app.delete('/jobs/:id', handler);
  app.all('/jobs/*', handler);
};
