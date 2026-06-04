# ADR 0003: Typed Tool Policy

## Status

Accepted

## Context

AI workflows need tools, but production systems need predictable inputs, bounded side effects, timeouts, and debuggable failures.

## Decision

Represent every tool with a typed definition, explicit input validation, declared side effect level, timeout, optional result summary, and optional source extraction.

## Consequences

The runtime can reject unsafe or malformed actions before execution and preserve failures as observations. This adds a little boilerplate per tool, but keeps the model boundary auditable.
