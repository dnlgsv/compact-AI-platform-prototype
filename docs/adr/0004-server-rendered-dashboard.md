# ADR 0004: Server-Rendered Dashboard

## Status

Accepted

## Context

The dashboard exists to inspect runs, traces, citations, and artifacts. It is not yet a rich product UI.

## Decision

Render the dashboard directly from the Node.js API with plain HTML and CSS. Avoid a frontend build pipeline until there is a concrete interactive workflow that needs one.

## Consequences

The operational UI stays easy to run and deploy. The tradeoff is less client-side interactivity, which is acceptable while the core platform contracts are still the main focus.
