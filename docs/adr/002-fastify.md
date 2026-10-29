# ADR 002: Fastify with Zod and OpenAPI, not Express or NestJS

**Status:** Accepted

## Context
The backend is a thin, security-sensitive API: authentication, uploads, metering, and enqueueing
work for the ML worker. The frontend consumes its types, and CI must catch contract drift.

## Decision
Use Fastify 5 with Zod schemas, `@fastify/swagger` for the OpenAPI document, and plugins for auth,
errors and rate limiting.

## Why
- **Schemas are the contract.** Zod validates requests, and the same schemas produce
  `backend/openapi.json`. The frontend generates `api.generated.ts` from it, and the CI
  `test:drift` check fails when the two disagree.
- **Small, explicit surface.** Plugins encapsulate auth, the error handler (RFC 7807 responses)
  and tracing hooks. There is no decorator or dependency-injection layer to learn.
- **Good defaults for this workload.** Built-in structured logging (Pino), fast JSON handling, and
  lifecycle hooks used for request spans and security headers.
- **Testable without a network.** `app.inject()` drives the route tests, including the IDOR matrix
  that walks every registered route.

## Costs
- Fewer ready-made integrations than Express, and no opinionated module structure as in NestJS.
  Structure is by convention (`routes/`, `services/`, `plugins/`), which relies on review.
- Zod and Fastify plugin majors move together, so upgrades need a full test run (the zod 4
  upgrade needed `z.guid()` for IDs and a new JSON Schema generator).

## Revisit when
The team grows enough that enforced module boundaries and dependency injection save more time
than they cost.
