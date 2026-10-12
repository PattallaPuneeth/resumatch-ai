import { prisma } from './prisma.js';

async function seed(): Promise<void> {
  console.log('🌱 Starting database seeding (Phase 1)...');

  // Upsert system admin/demo user
  const user = await prisma.user.upsert({
    where: { email: 'demo@resumatch.ai' },
    update: {},
    create: {
      email: 'demo@resumatch.ai',
      fullName: 'Demo Candidate',
      role: 'CANDIDATE',
    },
  });

  console.log(`✓ Seeded demo user: ${user.email} (${user.id})`);

  // Seed baseline sample job
  const job = await prisma.job.create({
    data: {
      userId: user.id,
      title: 'Senior Full Stack Engineer',
      company: 'Antigravity AI',
      location: 'Remote',
      jobType: 'FULL_TIME',
      rawDescription:
        'Seeking an experienced Senior Full Stack Engineer with expertise in TypeScript, Node.js, Fastify, Python, FastAPI, and PostgreSQL with pgvector. Candidate will architect scalable ingestion pipelines and hybrid vector search systems.',
      requiredSkills: ['TypeScript', 'Node.js', 'Python', 'PostgreSQL', 'pgvector'],
      preferredSkills: ['Fastify', 'FastAPI', 'BullMQ', 'Docker'],
      status: 'ACTIVE',
    },
  });

  console.log(`✓ Seeded demo job: ${job.title} at ${job.company} (${job.id})`);

  // Log audit event
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'SYSTEM_SEED',
      entityType: 'JOB',
      entityId: job.id,
      details: {
        note: 'Phase 1 seed data initialization completed',
      },
    },
  });

  console.log('✓ Seeded system audit log');
  console.log('🌱 Database seeding completed successfully.');
}

seed()
  .catch((err) => {
    console.error('❌ Error during database seeding:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
