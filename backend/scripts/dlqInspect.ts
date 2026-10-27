#!/usr/bin/env node
/**
 * Phase 10A - Item C3: Dead Letter Queue Inspection & Replay Utility
 *
 * Usage:
 *   npx tsx scripts/dlqInspect.ts summary
 *   npx tsx scripts/dlqInspect.ts inspect <queue-name>
 *   npx tsx scripts/dlqInspect.ts retry <queue-name> <job-id>
 *   npx tsx scripts/dlqInspect.ts purge <queue-name>
 */

import { Queue } from 'bullmq';
import {
  MONITORED_QUEUES,
  getDlqName,
  getDlqQueue,
  retryDlqJob,
  closeDlqQueues,
} from '../src/queues/dlq.js';
import { redisConnectionOptions } from '../src/queues/bullmq.js';

// Security Guard: Refuse execution against non-localhost Redis targets
const redisHost = redisConnectionOptions.host;
if (redisHost !== 'localhost' && redisHost !== '127.0.0.1') {
  console.error(`Refusing to run dlqInspect against non-localhost Redis: ${redisHost}`);
  process.exit(1);
}

async function printSummary() {
  console.log('\n================ Dead Letter Queue Summary ================');
  console.log('Target Redis: %s:%d\n', redisHost, redisConnectionOptions.port);

  for (const queueName of MONITORED_QUEUES) {
    const dlq = getDlqQueue(queueName);
    const counts = await dlq.getJobCounts('waiting', 'active', 'completed', 'failed');
    const total = counts.waiting + counts.active + counts.completed + counts.failed;
    console.log(
      `  • %s: %d total (waiting: %d, active: %d, completed: %d, failed: %d)`,
      getDlqName(queueName),
      total,
      counts.waiting,
      counts.active,
      counts.completed,
      counts.failed
    );
  }
  console.log('===========================================================\n');
}

async function inspectQueue(queueName: string) {
  const dlq = getDlqQueue(queueName);
  const dlqName = getDlqName(queueName);
  const jobs = await dlq.getJobs(['waiting', 'active', 'failed'], 0, 50);

  console.log(`\nInspecting ${dlqName} (${jobs.length} jobs retrieved):\n`);
  if (jobs.length === 0) {
    console.log('  No dead-letter jobs found in this queue.');
    return;
  }

  for (const job of jobs) {
    console.log(`  Job ID: ${job.id}`);
    console.log(`    Failed At:      ${job.data.failedAt}`);
    console.log(`    Attempts Made:  ${job.data.attemptsMade}`);
    console.log(`    Error Message:  ${job.data.errorMessage}`);
    console.log(`    Original Queue: ${job.data.originalQueue}`);
    console.log(`    Payload:        ${JSON.stringify(job.data.payload)}`);
    if (job.data.errorStack) {
      console.log(`    Stack:          ${job.data.errorStack.split('\n')[0]}`);
    }
    console.log('  -------------------------------------------------------');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'summary';

  try {
    switch (command) {
      case 'summary':
      case 'list':
        await printSummary();
        break;

      case 'inspect': {
        const queueName = args[1];
        if (!queueName) {
          console.error('Usage: dlqInspect.ts inspect <queue-name>');
          process.exit(1);
        }
        await inspectQueue(queueName);
        break;
      }

      case 'retry': {
        const queueName = args[1];
        const jobId = args[2];
        if (!queueName || !jobId) {
          console.error('Usage: dlqInspect.ts retry <queue-name> <job-id>');
          process.exit(1);
        }
        const targetQueue = new Queue(queueName, {
          connection: redisConnectionOptions,
          prefix: 'bull',
        });
        const success = await retryDlqJob(getDlqName(queueName), jobId, targetQueue);
        await targetQueue.close();
        if (success) {
          console.log(`Successfully replayed job ${jobId} back to ${queueName}`);
        } else {
          console.error(`Job ${jobId} not found in ${getDlqName(queueName)}`);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Available commands: summary, inspect <queue>, retry <queue> <job-id>');
        process.exit(1);
    }
  } finally {
    await closeDlqQueues();
  }
}

main().catch((err) => {
  console.error('DLQ inspection failed:', err);
  process.exit(1);
});
