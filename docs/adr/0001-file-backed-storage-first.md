# ADR 0001: File-Backed Storage First

## Status

Accepted

## Context

The prototype needs replayable run artifacts, dashboard inspection, and deterministic local demos before it needs multi-tenant persistence or distributed workers.

## Decision

Use validated JSON artifacts under `runs/` as the first storage layer. Keep the `RunStorage` interface small so a database-backed implementation can replace it later.

## Consequences

This keeps local development and portfolio demos simple. It also makes every saved run easy to inspect and diff. The tradeoff is that file storage is not suitable for high concurrency, multi-host deployment, or complex queries.
