import { escalateRevenuePlanSafety, validateRevenueExperimentPlan } from "./revenue-plan.js";
import type { AutomatonDatabase, Opportunity, RevenueExperimentPlan } from "../types.js";

export const REVIEW_FINDING_FIELDS = ["customerEvidence", "problemEvidence", "offerFeasibility", "channelRealism",
  "pricePlausibility", "experimentQuality", "successMetricQuality", "safety"] as const;
export type ReviewDecision = "approve_for_human_review" | "revise" | "reject";
export interface RevenueExperimentReview {
  planId: string;
  decision: ReviewDecision;
  score: number;
  findings: Record<typeof REVIEW_FINDING_FIELDS[number], string>;
  unsupportedAssumptions: string[];
  revisionSuggestions: string[];
  requiresHumanApproval: true;
  requiresExternalAction: boolean;
}
export interface DeterministicReviewChecks {
  hardErrors: string[];
  concerns: string[];
  requiresExternalAction: boolean;
}

/** Shape/safety checks only; commercial feasibility requires semantic and human review. */
export function checkRevenueExperimentDraft(plan: RevenueExperimentPlan, opportunity: Opportunity): DeterministicReviewChecks {
  const result: DeterministicReviewChecks = { hardErrors: [], concerns: [], requiresExternalAction: true };
  try { validateRevenueExperimentPlan(plan); }
  catch (error) { result.hardErrors.push(error instanceof Error ? error.message : "Invalid draft"); return result; }
  if (plan.opportunityId !== opportunity.id) result.hardErrors.push("Plan does not match the originating opportunity.");
  result.requiresExternalAction = escalateRevenuePlanSafety(plan, opportunity.requiresExternalAction).requiresExternalAction;
  const evidence = [opportunity.title, opportunity.description, ...opportunity.evidence].join(" ");
  if (/\bexisting\s+(?:users|customers|clients)\b/i.test(plan.channel) &&
      !/\b(?:our|we have|we serve)\b.{0,60}\b(?:users|customers|clients)\b/i.test(evidence)) {
    result.concerns.push("Existing users/customers are unsupported by source evidence; verify access to the proposed channel.");
  }
  if (/\b(?:businesses|companies)\b/i.test(plan.customer) && /\b(?:such as|or|small to mid|all|any)\b/i.test(plan.customer)) {
    result.concerns.push("Target customer is broad; choose one specific segment.");
  }
  if (!/\d|\b(?:one|two|three|four|five|at least|zero)\b/i.test(plan.successMetric)) {
    result.concerns.push("Success metric lacks a detectable measurable threshold.");
  }
  if (/\b\d+(?:st|nd|rd|th)\s+user\s+onward\b/i.test(plan.successMetric)) {
    result.concerns.push("Success metric cohort is ambiguous: ordinal user onward must align with the free/paid experiment cohorts.");
  }
  if (/\b(?:guaranteed|validated market price|proven price)\b/i.test(plan.revenueModel)) {
    result.concerns.push("Price certainty is unsupported; distinguish test price from validated market price.");
  }
  if (result.requiresExternalAction && !plan.requiresExternalAction) {
    result.concerns.push("External action flag escalated to true; human approval is required before any action.");
  }
  return result;
}

export function validateRevenueExperimentReview(value: unknown): asserts value is RevenueExperimentReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid review shape");
  const review = value as RevenueExperimentReview;
  if (typeof review.planId !== "string" || !review.planId.trim() || review.planId.length > 2000 ||
      !["approve_for_human_review", "revise", "reject"].includes(review.decision) ||
      !Number.isFinite(review.score) || review.score < 0 || review.score > 100 ||
      review.requiresHumanApproval !== true || typeof review.requiresExternalAction !== "boolean") throw new Error("Invalid review invariants");
  for (const field of REVIEW_FINDING_FIELDS) {
    if (typeof review.findings?.[field] !== "string" || !review.findings[field].trim() || review.findings[field].length > 2000) {
      throw new Error(`Invalid review finding: ${field}`);
    }
  }
  for (const list of [review.unsupportedAssumptions, review.revisionSuggestions]) {
    if (!Array.isArray(list) || list.length > 20 || list.some((item) => typeof item !== "string" || !item.trim() || item.length > 1000)) {
      throw new Error("Invalid review explanation list");
    }
  }
}

// One informational latest review per plan. No execution status or approval API.
const REVIEW_KEY_PREFIX = "revenue_experiment_review:";
type ReviewStore = Pick<AutomatonDatabase, "getRevenueExperimentPlanById" | "setKV" | "getKV" | "runTransaction">;
export function saveRevenueExperimentReview(db: ReviewStore, review: RevenueExperimentReview): void {
  validateRevenueExperimentReview(review);
  db.runTransaction(() => {
    const record = db.getRevenueExperimentPlanById(review.planId);
    if (!record || record.plan.status !== "draft") throw new Error("Review requires a persisted draft plan");
    const safe = { ...review, requiresExternalAction: review.requiresExternalAction || escalateRevenuePlanSafety(record.plan).requiresExternalAction };
    db.setKV(REVIEW_KEY_PREFIX + review.planId, JSON.stringify(safe));
  });
}
export function getRevenueExperimentReview(db: Pick<AutomatonDatabase, "getKV">, planId: string): RevenueExperimentReview | undefined {
  const text = db.getKV(REVIEW_KEY_PREFIX + planId);
  if (text === undefined) return undefined;
  const review: unknown = JSON.parse(text);
  validateRevenueExperimentReview(review);
  if (review.planId !== planId) throw new Error("Review plan reference mismatch");
  return review;
}
