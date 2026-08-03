import type { RouteDecisionMetadata } from "@/api/types";

export function formatRoutingDecisionSummary(decision: RouteDecisionMetadata): string {
  const source = decision.source === "heuristic"
    ? "auto-routed"
    : decision.source === "agent_override"
      ? "agent-selected"
      : decision.source === "pinned"
        ? "pinned"
        : "default fallback";
  const model = decision.model_config_name?.trim() || "(no model)";
  const routeClass = decision.route_class ? humanizeRouteClass(decision.route_class) : null;
  const base = routeClass && decision.policy
    ? `${source} to ${model} for ${routeClass} (${decision.policy})`
    : routeClass
      ? `${source} to ${model} for ${routeClass}`
      : `${source} to ${model}`;
  const suffix: string[] = [];
  if (typeof decision.duration_ms === "number" && decision.duration_ms > 0) {
    suffix.push(formatRoutingDuration(decision.duration_ms));
  }
  if ((decision.retry_count ?? 0) > 0) {
    suffix.push(`retried ${decision.retry_count}x`);
  }
  return suffix.length > 0 ? `${base} · ${suffix.join(" · ")}` : base;
}

export function humanizeRouteClass(routeClass: NonNullable<RouteDecisionMetadata["route_class"]>): string {
  switch (routeClass) {
    case "simple-chat":
      return "simple chat";
    case "complex-reasoning":
      return "complex reasoning";
    default:
      return routeClass;
  }
}

export function formatRoutingDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "0ms";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}