/**
 * Local Developer JWT Minting Utility
 *
 * Strictly development-only: refuses execution when NODE_ENV === 'production'.
 * Signs a valid JWT token using JWT_SECRET for local manual testing.
 * Requires an existing user in the database; never uses fallback identities.
 */
import { buildServer } from '../server.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';

export async function generateDevToken(emailInput?: string): Promise<{ userId: string; email: string; token: string }> {
  if (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production') {
    throw new Error('mintDevToken is strictly forbidden in production.');
  }

  const email = emailInput || 'demo@resumatch.ai';

  let user;
  try {
    user = await prisma.user.findUnique({ where: { email } });
  } catch (dbErr) {
    throw new Error(`Database query failed while looking up user: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
  }

  if (!user) {
    throw new Error(`User with email "${email}" not found in database. Run "npm run db:seed" or provide an existing user email.`);
  }

  const app = buildServer();
  await app.ready();

  try {
    const token = app.jwt.sign({
      sub: user.id,
      email: user.email,
    });

    return {
      userId: user.id,
      email: user.email,
      token,
    };
  } finally {
    await app.close();
  }
}

async function main() {
  const emailArg = process.argv[2];
  try {
    const result = await generateDevToken(emailArg);
    console.log(`\n=== ResuMatch AI Developer Bearer Token ===`);
    console.log(`User ID : ${result.userId}`);
    console.log(`Email   : ${result.email}`);
    console.log(`\nBearer ${result.token}\n`);
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
}

// Execute when invoked directly via CLI
if (process.argv[1] && process.argv[1].includes('mintDevToken')) {
  main();
}
