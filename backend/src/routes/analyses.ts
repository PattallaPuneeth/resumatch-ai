import type { FastifyPluginAsync } from 'fastify';

export const analysesRoutes: FastifyPluginAsync = async (app) => {
  const handler = async (_request: unknown, reply: any) => {
    return reply.status(501).send({
      statusCode: 501,
      error: 'Not Implemented',
      message: 'Resume analysis and bullet rewrite endpoint is not yet implemented. Available in Phase 2.',
    });
  };

  app.get('/analyses', handler);
  app.post('/analyses', handler);
  app.get('/analyses/:id', handler);
  app.all('/analyses/*', handler);
};
