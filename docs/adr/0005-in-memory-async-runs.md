# ADR 0005: In-Memory Async Runs First

## Status

Accepted

## Context

Production AI platforms usually run requests asynchronously, but adding Redis, BullMQ, or Postgres too early would obscure the runtime and workflow contracts.

## Decision

Add an in-memory queue with `queued`, `running`, `completed`, and `failed` states. Keep the queue interface separate from HTTP routing so a durable queue can replace it later.

## Consequences

The API can expose `202 Accepted` and polling semantics without heavy infrastructure. Jobs are lost on process restart, so this is a platform contract and demo path, not a production durability layer.
