---
status: accepted
date: 2026-10-07
---

# Global and per-agent usage strategies

## Context

Users need one global control for choosing a cost, balanced, or reasoning-oriented default, while retaining agent-level exceptions. Router policy alone does not control prompt style, context allocation, output limits, or automatic retry turns, and replacing an agent's harness would discard user-authored behavior.

## Decision Drivers

* Keep balanced mode behavior compatible with current defaults.
* Let per-agent strategy settings inherit the global strategy unless explicitly overridden.
* Preserve pinned models and explicit per-agent routing choices.
* Bound cost-saving context allocation without claiming a hard dollar ceiling.
* Keep provider failures retryable while avoiding additional quality-retry turns in cost-saving mode.

## Considered Options

* Expand the existing router policy enum to carry all usage behavior.
* Add a global strategy and a nullable per-agent strategy, resolved into a runtime profile.
* Replace harnesses with built-in strategy-specific harnesses.

## Decision Outcome

Chosen option: "Add a global strategy and a nullable per-agent strategy, resolved into a runtime profile." The strategy is orthogonal to routing and harness configuration, so it can add response guidance and runtime limits without replacing custom harnesses.

### Profiles

* `cost_saving` uses cheap routing unless an explicit per-agent router setting says otherwise, reduces context allocation, asks thinking models to reason less where the provider supports it (DeepSeek V4 thinking off; OpenAI gpt-5 and o-series reasoning effort lowered; an explicit `thinking` or `reasoning_effort` on the model config wins), adds concise-response guidance, disables quality-retry turns, and permits at most one transient provider-failure retry. It does not impose an output-token ceiling below the selected model's real limit.
* `balanced` inherits the existing global router mode and policy and adds no new limits or prompt guidance.
* `high_reasoning` favors quality routing and adds guidance to compare evidence and alternatives. It does not set provider-specific reasoning parameters because their contracts differ.

An explicit agent model remains pinned. An explicit per-agent router enable or policy takes precedence over the strategy's router defaults. The global transient retry setting can still disable provider retries; cost-saving only caps its retry allowance at one.

### Consequences

* Good, because users can change the default once and inspect or link to every agent override.
* Good, because cost-saving still performs local stall/fabrication checks and reports issues without starting an extra quality-retry turn.
* Bad, because the context allocation can reduce available history for unusually large tasks in cost-saving mode.
* Bad, because usage-reported pricing may be incomplete; these profiles are not spend guarantees.

## More Information

The global setting is `JARELA_USAGE_STRATEGY`. Per-agent overrides are stored in `agent_configs.usage_strategy`; NULL inherits the global setting. Existing harnesses remain unchanged and receive the strategy instruction as dynamic prompt content.

### Unreleased amendment: output follows model limits

The earlier adaptive, strategy-scaled output allocation is superseded. Output
defaults to the model's known maximum output, or 20% of its real context when
that limit is unknown, capped by remaining context. A configured `max_tokens`
replaces the default, while physical model and context limits remain hard
ceilings. Usage strategies no longer reduce the output ceiling. See the
[current operating guide](../OPERATIONS.md#model-output-limits-unreleased).

### Unreleased amendment: model-relative context allocation

The fixed Cost-saving context cap is superseded by selected-model-relative
context allocation: 60% for Cost-saving, 50% for Fast, 80% for Balanced, and
100% for High reasoning. Attachment turns use the full configured context
window. Output defaults to the selected model's known maximum output tokens,
or 20% of its real context if unknown, capped by remaining context; a user-set
`max_tokens` overrides that default, subject to physical model and context
limits. See the [current operating guide](../OPERATIONS.md#model-output-limits-unreleased).
