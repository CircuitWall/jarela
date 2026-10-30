import { describe, expect, it } from "vitest";
import {
  DEFAULT_DELEGATION_MAX_CALLS,
  DEFAULT_DELEGATION_MAX_COST_USD,
  DEFAULT_DELEGATION_MAX_DURATION_MS,
  claimDelegationCall,
  createDelegationBudget,
  delegationBudgetRemainingMs,
  delegationBudgetSnapshot,
  isDelegationBudget,
  reserveDelegationCost,
  settleDelegationCost,
} from "./delegation-budget";

describe("delegation budget", () => {
  it("uses documented limits and accepts only internally-created budget handles", () => {
    const budget = createDelegationBudget({ now: () => 1_000 });
    expect(isDelegationBudget(budget)).toBe(true);
    expect(isDelegationBudget({})).toBe(false);
    expect(delegationBudgetSnapshot(budget)).toMatchObject({
      calls: 0,
      remainingCalls: DEFAULT_DELEGATION_MAX_CALLS,
      committedCostUsd: 0,
      reservedCostUsd: 0,
      remainingCostUsd: DEFAULT_DELEGATION_MAX_COST_USD,
      remainingMs: DEFAULT_DELEGATION_MAX_DURATION_MS,
    });
  });

  it("shares call limits across sequential and fan-out claims", () => {
    const budget = createDelegationBudget({ maxCalls: 2 });
    expect(claimDelegationCall(budget)).toEqual({ ok: true, callNumber: 1 });
    expect(claimDelegationCall(budget)).toEqual({ ok: true, callNumber: 2 });
    expect(claimDelegationCall(budget)).toEqual({ ok: false, reason: "calls_exhausted" });
    expect(delegationBudgetSnapshot(budget)?.calls).toBe(2);
  });

  it("enforces the shared wall-clock deadline", () => {
    let now = 100;
    const budget = createDelegationBudget({ maxDurationMs: 20, now: () => now });
    expect(delegationBudgetRemainingMs(budget)).toBe(20);
    expect(claimDelegationCall(budget).ok).toBe(true);
    now += 20;
    expect(delegationBudgetRemainingMs(budget)).toBe(0);
    expect(claimDelegationCall(budget)).toEqual({ ok: false, reason: "time_exhausted" });
    expect(reserveDelegationCost(budget, 0.01)).toEqual({ ok: false, reason: "time_exhausted" });
  });

  it("refuses unknown prices and reservations exceeding the cost ceiling", () => {
    const budget = createDelegationBudget({ maxCostUsd: 0.02 });
    expect(reserveDelegationCost(budget, null)).toEqual({ ok: false, reason: "unknown_cost" });
    const first = reserveDelegationCost(budget, 0.015);
    expect(first.ok).toBe(true);
    expect(reserveDelegationCost(budget, 0.006)).toEqual({ ok: false, reason: "cost_exhausted" });
    if (first.ok) settleDelegationCost(first.reservation, null);
    expect(delegationBudgetSnapshot(budget)).toMatchObject({
      committedCostUsd: 0.015,
      reservedCostUsd: 0,
    });
    expect(delegationBudgetSnapshot(budget)?.remainingCostUsd).toBeCloseTo(0.005);
  });

  it("charges provider usage when known and retains the full bound when usage is unknown", () => {
    const budget = createDelegationBudget({ maxCostUsd: 0.03 });
    const known = reserveDelegationCost(budget, 0.02);
    expect(known.ok).toBe(true);
    if (known.ok) expect(settleDelegationCost(known.reservation, 0.01)).toEqual({ chargedUsd: 0.01, overrun: false });
    const unknown = reserveDelegationCost(budget, 0.02);
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(settleDelegationCost(unknown.reservation, null)).toEqual({ chargedUsd: 0.02, overrun: false });
    expect(delegationBudgetSnapshot(budget)?.committedCostUsd).toBeCloseTo(0.03);
  });

  it("never refunds an overrun beyond its conservative reservation", () => {
    const budget = createDelegationBudget({ maxCostUsd: 0.01 });
    const reserved = reserveDelegationCost(budget, 0.01);
    expect(reserved.ok).toBe(true);
    if (reserved.ok) {
      expect(settleDelegationCost(reserved.reservation, 0.02)).toEqual({ chargedUsd: 0.02, overrun: true });
    }
    expect(delegationBudgetSnapshot(budget)?.remainingCostUsd).toBe(0);
    expect(delegationBudgetSnapshot(budget)?.costLimitExceeded).toBe(true);
  });
});
