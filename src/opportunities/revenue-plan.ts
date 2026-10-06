import type { RevenueExperimentPlan } from "../types.js";
import { requiresExternalAction } from "./safety.js";

export const REVENUE_PLAN_TEXT_FIELDS = [
  "opportunityId", "problem", "customer", "offer", "channel", "revenueModel", "experiment", "successMetric",
] as const;

/** Shared monotonic safety classification for parsing and explicit storage. */
export function escalateRevenuePlanSafety(plan: RevenueExperimentPlan, sourceRequiresExternalAction = false): RevenueExperimentPlan {
  const texts = REVENUE_PLAN_TEXT_FIELDS.filter((field) => field !== "opportunityId").map((field) => plan[field]);
  return {
    ...plan,
    requiresExternalAction: requiresExternalAction({
      title: plan.offer, description: texts.join(" "), evidence: [],
      requiresExternalAction: sourceRequiresExternalAction || plan.requiresExternalAction,
    }) || /\b(?:email|dm|social\s+media|marketplace|public\s+posting)\b/i.test(plan.channel),
  };
}

/** Shared validation for model parsing and explicit draft persistence. */
export function validateRevenueExperimentPlan(value: unknown): asserts value is RevenueExperimentPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid revenue experiment plan");
  const plan = value as RevenueExperimentPlan;
  for (const field of REVENUE_PLAN_TEXT_FIELDS) {
    if (typeof plan[field] !== "string" || !plan[field].trim() || plan[field].length > 2000) {
      throw new Error(`Invalid revenue experiment plan field: ${field}`);
    }
  }
  for (const field of ["proposedPriceCents", "estimatedCostCents"] as const) {
    if (!Number.isSafeInteger(plan[field]) || plan[field] < 0) throw new Error(`Invalid revenue experiment plan field: ${field}`);
  }
  if (!["low", "medium", "high"].includes(plan.riskLevel) ||
      typeof plan.requiresExternalAction !== "boolean" || plan.status !== "draft") {
    throw new Error("Revenue experiment plans must have a supported risk, boolean action flag and draft status");
  }
}
