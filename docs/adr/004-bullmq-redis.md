# ADR 004: BullMQ on Redis, not Kafka or RabbitMQ

**Status:** Accepted

## Context
Parsing, embedding, matching and analysis take seconds to minutes and run in a Python worker. The
API must return quickly, retry transient failures, and never lose or duplicate a job. Redis is
already required for rate limiting and idempotency keys.

## Decision
Use BullMQ queues on the existing Redis instance. The backend produces jobs; the Python worker
consumes them. Queues, concurrency, retry and dead-letter policy are listed in
[docs/RELIABILITY.md](../RELIABILITY.md).

## Why
- **Fits the job shape.** Work items, not event streams: per-job retries with exponential backoff,
  deterministic job IDs (`match-{resumeId}-{jobId}`) for deduplication, and repeatable jobs for
  the 24-hour cleanup.
- **No new infrastructure.** Redis is already deployed. `docs/RULE.md` rule 7 rules out Kafka
  without a demonstrated need, and nothing here needs replay, partitioned ordering or fan-out to
  many consumers.
- **Failure handling is explicit.** After the retry limit a job moves to `<queue>-dlq`, and
  `backend/scripts/dlqInspect.ts` inspects it. State machines are mirrored in TypeScript and
  Python so a failed stage fails the job.
- **Traces cross the queue.** A W3C `traceparent` carrier travels in the payload, so one trace
  spans the request, the queue and the worker.

## Costs
- Redis is the single point of failure for queueing, rate limiting and idempotency. Auth routes
  fail closed with 503 when it is unavailable.
- Delivery is at-least-once, so every consumer must be idempotent (persistence is atomic and keyed
  by resume or job).
- No event log to replay. Recovery is by re-enqueueing from database state.

## Revisit when
Several independent consumers need the same event stream, or durable replay and audit of events
becomes a requirement.
