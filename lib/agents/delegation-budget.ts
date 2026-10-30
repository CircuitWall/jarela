/** Maximum delegate starts shared by the root task and all descendants. */
export const DEFAULT_DELEGATION_MAX_CALLS = 8;
/** Wall-clock ceiling shared by queue wait and active descendant execution. */
export const DEFAULT_DELEGATION_MAX_DURATION_MS = 120_000;
/** USD-estimate ceiling; each child reserves its full context window at the canonical max rate. */
export const DEFAULT_DELEGATION_MAX_COST_USD = 1;

export interface DelegationBudgetLimits {
  maxCalls?: number;
  maxDurationMs?: number;
  maxCostUsd?: number;
  now?: () => number;
}

export interface DelegationBudget {
  readonly __delegationBudget?: never;
}

export interface DelegationCostReservation {
  readonly __delegationCostReservation?: never;
}

type ReservationFailure = "cost_exhausted" | "unknown_cost" | "invalid_cost" | "time_exhausted";

interface BudgetState {
  readonly now: () => number;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly queueExpiresAt: number;
  readonly maxCalls: number;
  readonly maxCostUsd: number;
  calls: number;
  committedCostUsd: number;
  reservedCostUsd: number;
  costLimitExceeded: boolean;
}

interface CostReservationState {
  readonly budget: DelegationBudget;
  readonly amountUsd: number;
  settled: boolean;
}

const budgets = new WeakMap<object, BudgetState>();
const costReservations = new WeakMap<object, CostReservationState>();

export function createDelegationBudget(limits: DelegationBudgetLimits = {}): DelegationBudget {
  const now = limits.now ?? (() => performance.now());
  const startedAt = now();
  const durationMs = positiveInteger(limits.maxDurationMs, DEFAULT_DELEGATION_MAX_DURATION_MS);
  const budget = Object.freeze({});
  budgets.set(budget, {
    now,
    startedAt,
    deadlineAt: startedAt + durationMs,
    queueExpiresAt: Date.now() + durationMs,
    maxCalls: positiveInteger(limits.maxCalls, DEFAULT_DELEGATION_MAX_CALLS),
    maxCostUsd: positiveNumber(limits.maxCostUsd, DEFAULT_DELEGATION_MAX_COST_USD),
    calls: 0,
    committedCostUsd: 0,
    reservedCostUsd: 0,
    costLimitExceeded: false,
  });
  return budget;
}

export function isDelegationBudget(value: unknown): value is DelegationBudget {
  return typeof value === "object" && value !== null && budgets.has(value);
}

export function claimDelegationCall(
  budget: DelegationBudget,
): { ok: true; callNumber: number } | {
  ok: false;
  reason: "time_exhausted" | "calls_exhausted" | "cost_exhausted";
} {
  const state = budgets.get(budget);
  if (!state || state.now() >= state.deadlineAt) return { ok: false, reason: "time_exhausted" };
  if (state.costLimitExceeded || state.committedCostUsd + state.reservedCostUsd >= state.maxCostUsd) {
    return { ok: false, reason: "cost_exhausted" };
  }
  if (state.calls >= state.maxCalls) return { ok: false, reason: "calls_exhausted" };
  state.calls += 1;
  return { ok: true, callNumber: state.calls };
}

export function reserveDelegationCost(
  budget: DelegationBudget,
  maximumCostUsd: number | null,
): { ok: true; reservation: DelegationCostReservation } | { ok: false; reason: ReservationFailure } {
  const state = budgets.get(budget);
  if (maximumCostUsd === null) return { ok: false, reason: "unknown_cost" };
  if (!state || !Number.isFinite(maximumCostUsd) || maximumCostUsd < 0) {
    return { ok: false, reason: "invalid_cost" };
  }
  if (state.now() >= state.deadlineAt) return { ok: false, reason: "time_exhausted" };
  const total = state.committedCostUsd + state.reservedCostUsd + maximumCostUsd;
  if (state.costLimitExceeded || total > state.maxCostUsd + Number.EPSILON) {
    return { ok: false, reason: "cost_exhausted" };
  }

  const reservation = Object.freeze({});
  costReservations.set(reservation, { budget, amountUsd: maximumCostUsd, settled: false });
  state.reservedCostUsd += maximumCostUsd;
  return { ok: true, reservation };
}

/**
 * Settle a reservation using provider-reported usage when available. When
 * usage or its pricing is unknown, the full conservative reservation remains
 * charged. A known overrun is charged at its reported canonical-price estimate
 * and closes the budget.
 */
export function settleDelegationCost(
  reservation: DelegationCostReservation,
  actualCostUsd: number | null,
): { chargedUsd: number; overrun: boolean } {
  const reservationState = costReservations.get(reservation);
  if (!reservationState || reservationState.settled) return { chargedUsd: 0, overrun: false };
  reservationState.settled = true;
  const budgetState = budgets.get(reservationState.budget);
  if (!budgetState) return { chargedUsd: reservationState.amountUsd, overrun: false };

  const validActual = actualCostUsd !== null && Number.isFinite(actualCostUsd) && actualCostUsd >= 0;
  const overrun = validActual && actualCostUsd > reservationState.amountUsd + Number.EPSILON;
  const chargedUsd = validActual ? actualCostUsd : reservationState.amountUsd;
  budgetState.reservedCostUsd = Math.max(0, budgetState.reservedCostUsd - reservationState.amountUsd);
  budgetState.committedCostUsd += chargedUsd;
  if (overrun || budgetState.committedCostUsd >= budgetState.maxCostUsd) {
    budgetState.costLimitExceeded = overrun || budgetState.committedCostUsd > budgetState.maxCostUsd;
  }
  return { chargedUsd, overrun };
}

export function delegationBudgetDeadline(budget: DelegationBudget): number | null {
  return budgets.get(budget)?.queueExpiresAt ?? null;
}

export function delegationBudgetRemainingMs(budget: DelegationBudget): number {
  const state = budgets.get(budget);
  return state ? Math.max(0, state.deadlineAt - state.now()) : 0;
}

export function delegationBudgetSnapshot(budget: DelegationBudget): {
  calls: number;
  remainingCalls: number;
  committedCostUsd: number;
  reservedCostUsd: number;
  remainingCostUsd: number;
  costLimitExceeded: boolean;
  remainingMs: number;
} | null {
  const state = budgets.get(budget);
  if (!state) return null;
  return {
    calls: state.calls,
    remainingCalls: Math.max(0, state.maxCalls - state.calls),
    committedCostUsd: state.committedCostUsd,
    reservedCostUsd: state.reservedCostUsd,
    remainingCostUsd: Math.max(0, state.maxCostUsd - state.committedCostUsd - state.reservedCostUsd),
    costLimitExceeded: state.costLimitExceeded,
    remainingMs: Math.max(0, state.deadlineAt - state.now()),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
