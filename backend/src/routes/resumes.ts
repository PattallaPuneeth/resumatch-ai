import type { FastifyPluginAsync } from 'fastify';

export const resumesRoutes: FastifyPluginAsync = async (app) => {
  const handler = async (_request: unknown, reply: any) => {
    return reply.status(501).send({
      statusCode: 501,
      error: 'Not Implemented',
      message: 'Resume management endpoint is not yet implemented. Available in Phase 2.',
    });
  };

  app.get('/resumes', handler);
  app.post('/resumes', handler);
  app.get('/resumes/:id', handler);
  app.delete('/resumes/:id', handler);
  app.all('/resumes/*', handler);
};
