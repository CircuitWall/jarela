# ADR-0107: Source-backed model metadata

Date: 2026-10-25

Status: Accepted

## Context

Pricing refreshes do not track rolling model versions or capability changes.
Static capability hints become stale, while provider announcements may describe
consumer-app features that are not available through the API.

## Decision

Extend the existing write-capability pricing refresh with an official-documents
model update check. Validate model identifiers and verbatim supporting evidence
before accepting API capability or version observations. Store observations in
the existing SQLite `memory_store`, under `model-metadata` and
`provider-api-features`, through a typed store.
No database migration or new data directory is required.

Overlay explicit observations on catalog and saved-model display metadata.
Missing observations never imply capability removal. Keep previous observations
on fetch/extraction failure and report failures explicitly. Never change saved
model IDs, credentials, request parameters, routing, or historical costs.

Report adoption gaps separately from advertised provider capabilities. The
scheduled agent must check for duplicate GitHub issues and file a sanitized
follow-up when code work is confirmed and authorized; missing GitHub access
must be reported rather than disguised as a successfully filed issue.

## Consequences

Model information can evolve without a release, but extraction still depends
on the configured pricing extractor model and available official documentation.
Evidence checks establish provenance, not semantic certainty or runtime support.
New native APIs still require reviewed adapter changes and live validation.
