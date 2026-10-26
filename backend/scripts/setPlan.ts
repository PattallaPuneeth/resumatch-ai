#!/usr/bin/env node
/**
 * Administrative script to assign a plan to a user.
 *
 * Usage:
 *   npx tsx scripts/setPlan.ts <username-or-userId> <planKey>
 *
 * Examples:
 *   npx tsx scripts/setPlan.ts testuser demo
 *   npx tsx scripts/setPlan.ts 11111111-1111-1111-1111-111111111111 unlimited
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: npx tsx scripts/setPlan.ts <username-or-userId> <planKey>');
    process.exit(1);
  }

  const [identifier, planKey] = args;

  // 1. Verify the plan exists in the database
  const plan = await prisma.plan.findUnique({
    where: { key: planKey },
  });

  if (!plan) {
    const availablePlans = await prisma.plan.findMany({ select: { key: true, name: true } });
    console.error(`❌ Plan "${planKey}" does not exist.`);
    console.error(`Available plans: ${availablePlans.map((p) => `${p.key} (${p.name})`).join(', ')}`);
    process.exit(1);
  }

  // 2. Find the user by ID or username
  let user = await prisma.user.findUnique({
    where: { id: identifier },
    select: { id: true, planKey: true },
  });

  if (!user) {
    const cred = await prisma.credential.findUnique({
      where: { usernameLower: identifier.toLowerCase().trim() },
      select: { userId: true },
    });

    if (cred) {
      user = await prisma.user.findUnique({
        where: { id: cred.userId },
        select: { id: true, planKey: true },
      });
    }
  }

  if (!user) {
    console.error(`❌ User "${identifier}" not found.`);
    process.exit(1);
  }

  const previousPlan = user.planKey;

  // 3. Update the user plan
  await prisma.user.update({
    where: { id: user.id },
    data: { planKey },
  });

  console.log(`✅ Successfully updated user "${identifier}" (ID: ${user.id})`);
  console.log(`   Previous plan: ${previousPlan}`);
  console.log(`   New plan:      ${planKey} (${plan.name})`);
  console.log(`   Limits:        ${JSON.stringify(plan.limits)}`);
}

main()
  .catch((err) => {
    console.error('❌ Error executing setPlan script:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
