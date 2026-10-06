import type { AutomatonDatabase, Opportunity } from "../types.js";

/** V1 points, centralized for later tuning. Unknown effort earns no effort bonus. */
export const OPPORTUNITY_SCORING_V1 = {
  valueBuckets: [
    { minimumCents: 100_000, points: 30 },
    { minimumCents: 10_000, points: 20 },
    { minimumCents: 1_000, points: 10 },
    { minimumCents: 1, points: 5 },
    { minimumCents: 0, points: 0 },
  ],
  confidenceWeight: 35,
  effortPoints: { unknown: 0, high: 5, medium: 12, low: 20 },
  riskPoints: { high: 0, medium: 8, low: 15 },
  externalActionPenalty: 5,
} as const;

export interface OpportunityEvaluation {
  opportunityId: string;
  score: number;
  components: {
    value: number;
    confidence: number;
    effort: number;
    risk: number;
    /** Positive amount subtracted from the total. Never changes safety metadata. */
    externalActionPenalty: number;
  };
  reasons: string[];
}

type EvaluationInput = Pick<Opportunity,
  "id" | "estimatedValueCents" | "estimatedEffort" | "riskLevel" | "confidence" | "requiresExternalAction"
>;
type RankingDatabase = Pick<AutomatonDatabase, "listOpportunities">;
type ShortlistingDatabase = RankingDatabase & Pick<AutomatonDatabase, "runTransaction" | "updateOpportunityReview">;

function roundPoints(points: number): number {
  return Math.round(points * 100) / 100;
}

/** Pure scoring: no inference, network, persistence or execution. */
export function evaluateOpportunity(opportunity: EvaluationInput): OpportunityEvaluation {
  const formula = OPPORTUNITY_SCORING_V1;
  const effort = formula.effortPoints[opportunity.estimatedEffort];
  const risk = formula.riskPoints[opportunity.riskLevel];
  if (!Number.isSafeInteger(opportunity.estimatedValueCents) || opportunity.estimatedValueCents < 0 ||
      !Number.isFinite(opportunity.confidence) || opportunity.confidence < 0 || opportunity.confidence > 1 ||
      typeof effort !== "number" || typeof risk !== "number" || typeof opportunity.requiresExternalAction !== "boolean") {
    throw new Error(`Invalid opportunity scoring fields: ${opportunity.id}`);
  }
  const value = formula.valueBuckets.find((bucket) => opportunity.estimatedValueCents >= bucket.minimumCents)!.points;
  const confidence = roundPoints(opportunity.confidence * formula.confidenceWeight);
  const externalActionPenalty = opportunity.requiresExternalAction ? formula.externalActionPenalty : 0;
  return {
    opportunityId: opportunity.id,
    score: roundPoints(Math.max(0, Math.min(100, value + confidence + effort + risk - externalActionPenalty))),
    components: { value, confidence, effort, risk, externalActionPenalty },
    reasons: [
      `Estimated value ${opportunity.estimatedValueCents} cents: ${value}/${formula.valueBuckets[0].points} points (bounded buckets).`,
      `Confidence ${opportunity.confidence}: ${confidence}/${formula.confidenceWeight} points.`,
      `Effort ${opportunity.estimatedEffort}: ${effort}/${formula.effortPoints.low} points.`,
      `Risk ${opportunity.riskLevel}: ${risk}/${formula.riskPoints.low} points.`,
      opportunity.requiresExternalAction
        ? `External action requires human approval: subtract ${externalActionPenalty} points.`
        : "No external-action penalty; shortlist still means human review only.",
    ],
  };
}

function compareText(left: string, right: string): number {
  // Code-unit ordering avoids locale-dependent collation.
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCreationTime(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  if (Number.isFinite(leftTime)) return -1;
  if (Number.isFinite(rightTime)) return 1;
  return compareText(left, right);
}

/** Read-only ranking: score DESC, confidence DESC, creation time ASC, ID ASC. */
export function rankDiscoveredOpportunities(db: RankingDatabase): OpportunityEvaluation[] {
  return db.listOpportunities({ status: "discovered" })
    .map((opportunity) => ({ opportunity, evaluation: evaluateOpportunity(opportunity) }))
    .sort((left, right) => right.evaluation.score - left.evaluation.score ||
      right.opportunity.confidence - left.opportunity.confidence ||
      compareCreationTime(left.opportunity.createdAt, right.opportunity.createdAt) ||
      compareText(left.opportunity.id, right.opportunity.id))
    .map(({ evaluation }) => evaluation);
}

/** Explicit review-only mutation. No score threshold or goal/task creation.
 * Default top 3; an explicit non-negative integer can request fewer or more.
 * Re-rank inside the transaction so only currently discovered rows transition.
 * Any failed transition rolls back every status/timestamp change in this batch.
 */
export function shortlistTopOpportunities(
  db: ShortlistingDatabase,
  maximum: number = 3,
): OpportunityEvaluation[] {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new Error("Shortlist maximum must be a non-negative integer");
  }
  if (maximum === 0) return [];
  return db.runTransaction(() => {
    const selected = rankDiscoveredOpportunities(db).slice(0, maximum);
    for (const evaluation of selected) {
      db.updateOpportunityReview(evaluation.opportunityId, { status: "shortlisted" });
    }
    return selected;
  });
}
