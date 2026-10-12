import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { redisClient } from './queues/redis.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const app = buildServer();

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}. Gracefully shutting down...`);
      try {
        await app.close();
        await prisma.$disconnect();
        await redisClient.quit().catch(() => {});
        app.log.info('Server and background connections shut down cleanly.');
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, 'Error occurred during graceful shutdown');
        process.exit(1);
      }
    });
  }

  try {
    const address = await app.listen({
      port: env.PORT,
      host: env.HOST,
    });
    app.log.info(`🚀 ResuMatch AI Backend running at ${address}`);
  } catch (err) {
    app.log.fatal({ err }, 'Fatal error starting server');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
