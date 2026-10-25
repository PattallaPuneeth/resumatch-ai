import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';

export interface JwtPayload {
  sub: string;   // userId
  email: string;
  iat?: number;
  exp?: number;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPlugin: FastifyPluginAsync = async (app) => {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: '7d',
    },
  });

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as JwtPayload | undefined;
      if (!user || typeof user.sub !== 'string' || user.sub.trim() === '') {
        request.log.warn({ user }, 'JWT missing required subject claim (sub)');
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid token payload: missing subject identifier.',
          timestamp: new Date().toISOString(),
          requestId: request.id,
        });
      }
    } catch (err) {
      request.log.warn({ err }, 'JWT authentication failed');
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Authentication required. Provide a valid Bearer token.',
        timestamp: new Date().toISOString(),
        requestId: request.id,
      });
    }
  });
};

export default fp(authPlugin, { name: 'auth' });
