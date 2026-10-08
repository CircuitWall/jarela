---
name: integration-development
description: "Use when: adding, changing, debugging, or reviewing a Jarela integration, OAuth provider, API connector, credential flow, LangChain tool package, integration manifest, or integration UI."
argument-hint: "Integration, provider, API, OAuth flow, or credential surface"
---

# Integration Development

Use this checklist for every new or changed integration. Treat the vendor API
contract and Jarela's credential lifecycle as one feature. Do not implement a
happy-path API call before verifying how authorization, persistence, setup, and
failure recovery work.

## Non-Negotiable Invariants

- Never place API keys, access tokens, refresh tokens, client secrets, OAuth
  codes, cookies, or private customer data in source, tests, prompts, logs,
  screenshots, proposal payloads, or documentation.
- Store persistent secrets only through the typed encrypted credential store.
  Do not create ad-hoc files, localStorage entries, plaintext JSON, or module
  globals for persistent credentials.
- Keep credentials, OAuth clients, tools, and integration IDs separate when
  they represent different accounts, permission boundaries, tenants, or
  business contexts.
- A provider's application approval, OAuth member consent, and resource-level
  role are separate gates. Document and test all three.
- Use the least-privileged scopes needed for the implemented feature. Never
  request a scope merely because it exists in vendor documentation.
- Never treat a successful OAuth redirect as proof that the API operation is
  authorized. Probe the actual resource or capability after connection.
- All external writes must be explicit write/execute tools and must preserve
  the repository's approval and capability model.

## Phase 1: Research Before Coding

- [ ] Identify the owning local abstraction: package, typed tool module,
      provider adapter, integration manifest, OAuth helper, credential store,
      and UI card/panel.
- [ ] Read current official vendor documentation, not old examples or blog
      posts, for:
      - [ ] authorization flow and token exchange
      - [ ] current endpoint paths and request/response schemas
      - [ ] exact scopes and which products provision them
      - [ ] account/member, organization/tenant, and application permissions
      - [ ] resource roles or ACLs required after OAuth
      - [ ] API version headers, supported versions, and sunset dates
      - [ ] token lifetime, refresh-token availability, rate limits, and errors
- [ ] Record the exact docs URLs and the date/version reviewed in the change
      notes or integration documentation.
- [ ] Identify one nearby existing integration with the same auth shape and
      one focused test that can disconfirm the implementation hypothesis.
- [ ] Decide whether this is a built-in package, in-tree tool, external tool,
      provider plugin, or MCP integration before editing.

## Phase 2: Design the Boundary

- [ ] Define the integration ID, package name, tool-name prefix, category,
      capability classification, and credential provider key.
- [ ] Define the auth shape explicitly. Include only fields the API client
      needs, and never pass raw store records into tools.
- [ ] Define the credential fields before implementing the client:
      - [ ] client ID and client secret, if OAuth requires them
      - [ ] access token and refresh token, if applicable
      - [ ] expiry timestamps and granted scopes
      - [ ] tenant, organization, account, or resource identifiers
      - [ ] non-secret API version or endpoint overrides
- [ ] Mark every secret credential field as secret in integration metadata and
      confirm the key is included in the credential redaction set.
- [ ] Decide whether the integration uses one or multiple credentials. Do not
      merge personal/member and organization/enterprise access into one token
      or resolver unless the vendor contract truly makes them identical.
- [ ] Define read, write, and execute tool groups before writing tools.
- [ ] Define a post-connect probe that proves the credential is useful, not
      merely present.

## Phase 3: OAuth and Credential Lifecycle

### Authorization Start

- [ ] Use the vendor's documented authorization endpoint and exact scopes.
- [ ] Generate unpredictable per-flow state and validate it on callback.
- [ ] Bind state to the intended integration, client ID, redirect URI, and
      credential ID where applicable.
- [ ] Keep client secrets and authorization codes server-side only.
- [ ] Register and use an exact redirect URI. Do not silently substitute a
      token-generator callback, a different port, or a browser-only URL.
- [ ] Make requested scopes configurable only when there is a documented need;
      validate them against scopes supported by that integration before redirect.
- [ ] Treat app configuration entered in the UI as data that must be persisted,
      not just temporary values used to start the flow.

### Callback and Persistence

- [ ] Handle provider denial, missing code, invalid state, expired state, and
      token-exchange failures separately.
- [ ] On success, persist the complete credential atomically or in one coherent
      update:
      - [ ] app client ID
      - [ ] app client secret
      - [ ] access token
      - [ ] refresh token, if returned
      - [ ] expiry information
      - [ ] requested and granted scopes
      - [ ] account/resource identity metadata, if known
- [ ] If the user did not save app configuration before clicking Connect, the
      callback must still save it with the exchanged token.
- [ ] If the UI sends masked secrets or omits them on reconnect, resolve the
      real values from the encrypted credential store. Never overwrite a real
      secret with a mask sentinel or `undefined`.
- [ ] If a credential ID is supplied, verify it exists and belongs to the
      expected integration before updating it.
- [ ] Do not claim refresh support unless the vendor and the specific app are
      eligible. Provide reconnect behavior for finite-lived tokens.
- [ ] Clear or expire temporary OAuth flow state after completion or timeout.

## Phase 4: Implement the Integration

### Standalone Package or Tool Client

- [ ] Follow the nearest package convention for ESM/CJS/types, build scripts,
      lazy auth resolution, injected test resolvers, and capability arrays.
- [ ] Send the exact authorization and API-version headers required by the
      vendor. Keep version selection explicit and configurable where needed.
- [ ] URL-encode path IDs, URNs, tenant IDs, and query values with structured
      APIs such as `URLSearchParams`.
- [ ] Validate tool input with Zod at the tool boundary.
- [ ] Cap or normalize large responses before returning them to the agent.
- [ ] Return sanitized, actionable errors. Include status and provider error
      class when useful, but never token material or unbounded raw responses.
- [ ] Make resource ownership explicit in write tools. A page, organization,
      repository, mailbox, or tenant must not be inferred from an unrelated
      member token without a documented authorization check.

### Jarela Registration

- [ ] Add the integration definition and credential fields to
      `lib/stores/integrations.ts`.
- [ ] Add a manifest under `lib/integrations/<id>/manifest.ts`.
- [ ] Import the manifest in `lib/integrations/registry.ts` and include it in
      the registry array.
- [ ] Register package tools in `lib/tools/default-packages.ts`, or add the
      built-in module side-effect import when that is the local pattern.
- [ ] Connect the package resolver to Jarela's encrypted credential store.
- [ ] Add environment fallbacks only when they are documented, namespaced, and
      consistent with the integration's credential boundaries.
- [ ] Update any category unions, package catalogues, tool grouping maps,
      default-package lists, or API validation enums that enumerate built-ins.
- [ ] Add user-facing setup, approval, role, callback, scope, expiry, and
      troubleshooting guidance.

### Integration UI

- [ ] Add fields for every required setup value, with secret masking and safe
      save semantics.
- [ ] Add a Connect button only when the backend start/callback/status flow is
      complete.
- [ ] Open the vendor authorization URL from a user action and handle popup
      blocking, cancellation, timeout, success, and failure.
- [ ] Poll or receive callback status using the existing local pattern.
- [ ] Refresh the credential/status view after callback success.
- [ ] Verify that reconnect works when saved secrets are masked in the form.
- [ ] Keep personal/member and organization/enterprise controls visibly and
      operationally distinct.

## Phase 5: Tests and Validation

### Focused Tests

- [ ] Package typecheck passes.
- [ ] Mocked fetch tests verify exact URLs, methods, headers, version, query
      encoding, request bodies, and response/error handling.
- [ ] Resolver tests verify environment/store precedence and credential
      isolation.
- [ ] Schema tests reject empty, malformed, out-of-range, and wrong-resource
      identifiers.
- [ ] Write tests verify the capability classification and approval boundary.
- [ ] OAuth tests cover:
      - [ ] exact scope construction
      - [ ] unsupported-scope rejection
      - [ ] state mismatch
      - [ ] provider denial
      - [ ] missing/expired state
      - [ ] token exchange failure
      - [ ] successful persistence of app config plus tokens
      - [ ] reconnect using masked saved secrets
      - [ ] targeted credential provider mismatch
- [ ] Manifest and package-registration tests include the new IDs and tools.
- [ ] UI tests cover button wiring, popup failure, polling success, polling
      failure, timeout, and refresh after connection.

### Required Commands

Run the narrowest checks first, then widen only after they pass:

```powershell
npm run typecheck -w packages/<integration-package>
npm test -w packages/<integration-package>
npx vitest run <focused-root-tests>
npx tsc --noEmit
npm run lint
npm run build
npm run security:secrets
```

After the code is green:

- [ ] Inspect `git diff` and changed-file status.
- [ ] Search changed files for `token`, `secret`, `password`, `cookie`,
      `authorization`, real email addresses, callback codes, and private URLs.
- [ ] Confirm generated `dist/`, `.next/`, logs, screenshots, and test artifacts
      are ignored or intentionally excluded from the change.
- [ ] Perform a live smoke test with synthetic or explicitly supplied test
      accounts only. Label external test writes clearly and revoke test access
      when finished.

## Debugging Order

When an integration fails, diagnose in this order:

1. Is the correct integration ID and credential row present?
2. Did the OAuth callback persist both app configuration and token data?
3. Is the resolver reading the intended credential, rather than a default from
   another account or integration?
4. Does the token contain the exact requested and granted scope?
5. Does the authenticated member have the required resource role or ACL?
6. Is the endpoint, version, method, query encoding, and request body current?
7. Is the response a provider authorization error, rate limit, network/proxy
   error, or local serialization error?
8. Does the integration probe exercise the same path as the real tool?

Do not “fix” an authorization error by silently requesting every available
scope or by falling back to a different account. Make the missing product,
scope, role, or credential visible and actionable.
