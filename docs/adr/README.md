# Architecture Decision Records

Short records of the decisions that shape ResuMatch AI. Each states the context, the decision,
what it costs, and when to revisit it. Only claims the repository can back are included; where a
number is cited it links to where it was measured.

| ADR | Decision |
| :--- | :--- |
| [001](001-postgres-pgvector.md) | PostgreSQL with pgvector, not a separate vector database |
| [002](002-fastify.md) | Fastify with Zod and OpenAPI, not Express or NestJS |
| [003](003-hybrid-retrieval.md) | Hybrid retrieval with a cross-encoder, not vector search alone |
| [004](004-bullmq-redis.md) | BullMQ on Redis, not Kafka or RabbitMQ |
