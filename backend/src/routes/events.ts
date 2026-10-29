import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eventDispatcher, type SseEvent } from '../services/eventDispatcher.js';
import { asOpenApiSchema } from '../plugins/swagger.js';

const streamQuerySchema = z.object({
  token: z.string().optional(),
});

export const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/events/stream',
    {
      schema: {
        tags: ['Events'],
        summary: 'Subscribe to real-time user event stream via Server-Sent Events (SSE)',
        description:
          'Long-lived SSE connection pushing real-time asynchronous processing updates (e.g. resume parsing status, ATS score computation, match scoring) directly to the client.',
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        querystring: asOpenApiSchema(streamQuerySchema),
      },
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        // Support token in query string for native EventSource clients that cannot send Authorization headers
        if (!request.user) {
          const query = request.query as { token?: string };
          if (query?.token) {
            try {
              const decoded = app.jwt.verify<any>(query.token);
              if (decoded && typeof decoded.sub === 'string') {
                request.user = decoded;
              }
            } catch (err) {
              return reply.status(401).send({
                type: 'https://httpstatuses.com/401',
                title: 'Unauthorized',
                status: 401,
                detail: 'Invalid or expired stream authentication token',
                instance: request.url,
              });
            }
          }
        }

        // Standard authentication check
        if (!request.user || !request.user.sub) {
          return reply.status(401).send({
            type: 'https://httpstatuses.com/401',
            title: 'Unauthorized',
            status: 401,
            detail: 'Authentication required to subscribe to real-time events',
            instance: request.url,
          });
        }
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user.sub;

      // Prevent fastify reply from closing immediately; hand off raw stream
      reply.hijack();

      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send immediate connection handshake
      const initialPayload = JSON.stringify({ status: 'connected', userId });
      raw.write(`event: connected\ndata: ${initialPayload}\n\n`);

      // 15-second keepalive heartbeat to prevent intermediate proxy/load-balancer timeouts
      const keepaliveTimer = setInterval(() => {
        if (!raw.writableEnded) {
          raw.write(':keepalive\n\n');
        }
      }, 15000);

      // Subscribe to user events
      const unsubscribe = await eventDispatcher.subscribeUser(userId, (event: SseEvent) => {
        if (!raw.writableEnded) {
          raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      });

      // Clean up resources on client disconnect
      const cleanup = () => {
        clearInterval(keepaliveTimer);
        try { unsubscribe(); } catch (_) {}
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);

      if (request.headers['x-test-close-stream'] === 'true') {
        raw.end();
        cleanup();
      }
    }
  );
};
