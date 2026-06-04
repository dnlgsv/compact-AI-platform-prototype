# ADR 0002: Deterministic Evals Before LLM-as-Judge

## Status

Accepted

## Context

The first quality bar should catch contract regressions: citation grounding, malformed provider output, tool input validation, and graceful failure handling.

## Decision

Start with deterministic eval cases and a baseline file. Add report saving and report comparison before adding LLM-as-judge scoring.

## Consequences

Deterministic evals are cheap, reproducible, and CI-friendly. They do not measure answer nuance or writing quality, so judge-based evals remain a future extension rather than the first dependency.
