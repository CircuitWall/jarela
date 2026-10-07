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
* Bound cost-saving context and output allocation without claiming a hard dollar ceiling.
* Keep provider failures retryable while avoiding additional quality-retry turns in cost-saving mode.

## Considered Options

* Expand the existing router policy enum to carry all usage behavior.
* Add a global strategy and a nullable per-agent strategy, resolved into a runtime profile.
* Replace harnesses with built-in strategy-specific harnesses.

## Decision Outcome

Chosen option: "Add a global strategy and a nullable per-agent strategy, resolved into a runtime profile." The strategy is orthogonal to routing and harness configuration, so it can add response guidance and runtime limits without replacing custom harnesses.

### Profiles

* `cost_saving` uses cheap routing unless an explicit per-agent router setting says otherwise, caps context at 65,536 tokens (applied to the model's real window, not the 8k fallback) and output at 4,096 tokens, asks thinking models to reason less where the provider supports it (DeepSeek V4 thinking off; OpenAI gpt-5 and o-series reasoning effort lowered; an explicit `thinking` or `reasoning_effort` on the model config wins), keeps a 32,768-token output floor for thinking models that still reason, adds concise-response guidance, disables quality-retry turns, and permits at most one transient provider-failure retry.
* `balanced` inherits the existing global router mode and policy and adds no new limits or prompt guidance.
* `high_reasoning` favors quality routing and adds guidance to compare evidence and alternatives. It does not set provider-specific reasoning parameters because their contracts differ.

An explicit agent model remains pinned. An explicit per-agent router enable or policy takes precedence over the strategy's router defaults. The global transient retry setting can still disable provider retries; cost-saving only caps its retry allowance at one.

### Consequences

* Good, because users can change the default once and inspect or link to every agent override.
* Good, because cost-saving still performs local stall/fabrication checks and reports issues without starting an extra quality-retry turn.
* Bad, because context and output caps reduce available room for unusually large tasks in cost-saving mode.
* Bad, because usage-reported pricing may be incomplete; these profiles are not spend guarantees.

## More Information

The global setting is `JARELA_USAGE_STRATEGY`. Per-agent overrides are stored in `agent_configs.usage_strategy`; NULL inherits the global setting. Existing harnesses remain unchanged and receive the strategy instruction as dynamic prompt content.
