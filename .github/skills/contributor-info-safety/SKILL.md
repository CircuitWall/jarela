---
name: contributor-info-safety
description: "Use when: reviewing, committing, or opening PRs in Jarela where secrets, customer data, employer or corporate information, proprietary logs, credentials, screenshots, telemetry exports, or contributor machine details might leak. Provides an information-safety SOP."
argument-hint: "Files, diff, PR, issue, or artifact to check"
---

# Contributor Information Safety

## Goal

Prevent secrets, private user data, employer or corporate information, proprietary logs, and contributor machine details from leaking into commits, PRs, issues, release notes, screenshots, or generated artifacts.

Use this skill before committing or publishing changes that include logs, configuration, environment details, telemetry exports, screenshots, copied prompts, generated reports, browser captures, stack traces, or third-party integration data.

## Red Flags

Treat these as sensitive until proven otherwise:

- API keys, tokens, cookies, OAuth codes, session IDs, refresh tokens, app passwords, private keys, and signing material.
- Real customer names, company names, internal project names, employee names, email addresses, phone numbers, addresses, invoices, tickets, calendars, messages, or documents.
- Internal hostnames, private repository URLs, VPN domains, cloud account IDs, database paths, bucket names, webhook URLs, and non-public endpoints.
- Proprietary source excerpts copied from another employer, customer, vendor, or private repository not intended for this project.
- Raw production logs, browser captures, screenshots, crash dumps, telemetry exports, prompts, model transcripts, and terminal output containing real user data.
- Local machine paths that reveal usernames, organizations, clients, or synced corporate folders when they are not needed for debugging.

## SOP

1. Classify the material.
   - Identify whether the change includes source code, generated files, logs, fixtures, screenshots, configs, docs, or copied external text.
   - For any non-source artifact, ask what real-world data it came from and whether it can be replaced by synthetic data.

2. Inspect the diff before commit or PR.
   - Run `git diff --cached` for staged changes or `git diff` before staging.
   - Search changed files for common secret and private-data markers.
   - Pay special attention to new files, snapshots, fixtures, `.env*`, logs, screenshots, archives, generated reports, and package artifacts.

3. Sanitize aggressively.
   - Replace real names, companies, domains, emails, phone numbers, tokens, IDs, paths, and account details with realistic placeholders.
   - Prefer synthetic fixtures over redacted production data.
   - Keep examples structurally accurate while removing real identifiers.
   - Do not commit generated logs or screenshots unless they are necessary and sanitized.

4. Preserve useful debugging context safely.
   - Keep error classes, stack-frame shapes, HTTP status codes, schema names, and minimal reproduction inputs.
   - Remove raw request or response bodies unless they are synthetic.
   - Truncate long logs to the smallest relevant excerpt.
   - In PRs and issues, summarize sensitive findings instead of pasting raw data.

5. Respect third-party and employer boundaries.
   - Do not copy proprietary code, prompts, docs, tickets, customer messages, or internal policy text from another organization into this repo.
   - If a fix was informed by external research, link public sources instead of pasting private material.
   - If unsure whether material is owned by a contributor's employer or customer, leave it out and ask for a sanitized reproduction.

6. Handle accidental exposure.
   - Stop and avoid pushing more commits that repeat the secret.
   - Notify the maintainer/user with the exact file and kind of exposure, but do not repeat the secret value in chat.
   - Rotate the exposed credential or token before treating the issue as resolved.
   - If the secret was committed, remove it from the branch and coordinate history cleanup before merge.

7. PR and issue hygiene.
   - Use sanitized issue comments and PR bodies.
   - Do not include raw telemetry exports unless they are local, intentional, and scrubbed.
   - Mention that sensitive data was sanitized when that helps reviewers trust the fixture.
   - Use `Refs` or `Closes` normally, but never include confidential tracker titles or customer details in public references.

## Suggested Checks

```powershell
git diff --cached

git diff --cached --name-only

git diff --cached | Select-String -Pattern 'api[_-]?key|token|secret|password|cookie|authorization|bearer|private key|client_secret|refresh_token' -CaseSensitive:$false

git diff --cached | Select-String -Pattern '@[^\s]+\.[^\s]+|https?://[^\s]+' -CaseSensitive:$false
```

These searches are a backstop, not proof of safety. Review context manually before publishing.
