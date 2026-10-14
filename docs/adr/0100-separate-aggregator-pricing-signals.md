---
status: accepted
date: 2026-10-14
deciders: Jarela maintainers
---

# Keep aggregator pricing signals separate

## Context and Problem Statement

Provider pricing pages do not always expose usable per-model rates, while
aggregator catalogs may quote prices for routes that are not equivalent to
direct provider billing. We need broader model-price comparison data without
silently changing direct-provider cost estimates.

## Decision

Fetch OpenRouter and LiteLLM catalogs as optional comparison signals during
pricing snapshot refresh. Persist them in a separate `aggregators` section of
the existing pricing snapshot, retaining source URL, fetch status and time,
last-success time, route, cache rates, and conditional-pricing information.
On feed failure, preserve its last successful rates and report the current
failure separately.

Aggregator rates are never used as direct-provider rates or billing estimates.
Match them to supported providers and models only after canonical alias
normalization, and surface discrepancies rather than resolving them
automatically. Invalid, sentinel, negative, unsupported, or malformed entries
remain excluded; unknown rates remain null.

The snapshot extension is additive and optional so snapshots written before
this decision remain readable. The feature uses the existing pricing
maintenance flow and process; it adds no database migration or new process.

## Consequences

* Dashboard users can compare route/catalog quotes without confusing them with
  direct-provider prices.
* Feed attribution and failure history remain visible for review.
* Pricing refresh now depends on two additional public HTTPS sources when
  refresh is explicitly run; failures preserve the latest successful feed data.
* Snapshot readers must continue treating `aggregators` as optional for
  backward compatibility.
