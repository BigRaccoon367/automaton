/** Bounded discovery from supplied observations. No inference or external actions. */
import { validateOpportunity } from "../state/database.js";
import type { AutomatonDatabase, Opportunity, OpportunityInput } from "../types.js";

export const MAX_DISCOVERY_CANDIDATES = 3;

export interface OpportunityDiscoveryInput {
  source: string;
  observationText: string;
  /** Observation metadata passed to the generator, not the insertion timestamp. */
  timestamp?: string;
  context?: string;
}

export type OpportunityCandidate = Pick<Opportunity,
  "title" | "description" | "evidence" | "estimatedValueCents" |
  "estimatedEffort" | "riskLevel" | "confidence" | "requiresExternalAction"
>;

export type OpportunityCandidateGenerator = (
  input: OpportunityDiscoveryInput,
) => Promise<OpportunityCandidate[]>;

export interface OpportunityDiscoveryResult {
  /** Total returned by the generator, including candidates beyond the bound. */
  generated: number;
  inserted: number;
  duplicatesSkipped: number;
  invalidSkipped: number;
  limitSkipped: number;
  insertedIds: string[];
}

type DiscoveryDatabase = Pick<AutomatonDatabase,
  "listOpportunities" | "insertOpportunity" | "runTransaction"
>;

export function normalizeOpportunityTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function validateDiscoveryInput(input: OpportunityDiscoveryInput): void {
  if (!input || typeof input.source !== "string" || !input.source.trim()) {
    throw new Error("Discovery source must not be empty");
  }
  if (typeof input.observationText !== "string" || !input.observationText.trim()) {
    throw new Error("Discovery observation text must not be empty");
  }
  if (input.timestamp !== undefined &&
      (typeof input.timestamp !== "string" || !Number.isFinite(Date.parse(input.timestamp)))) {
    throw new Error("Discovery timestamp must be a valid date string");
  }
  if (input.context !== undefined && typeof input.context !== "string") {
    throw new Error("Discovery context must be text");
  }
}

/** Validate untrusted generator output; copy only discovery fields for storage. */
function prepareCandidate(value: unknown, source: string): OpportunityInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as OpportunityCandidate;
  if (typeof candidate.description !== "string" || !candidate.description.trim()) return undefined;
  try {
    validateOpportunity({ ...candidate, status: "discovered", convertedGoalId: null });
  } catch {
    return undefined;
  }
  return {
    title: candidate.title.trim(),
    description: candidate.description.trim(),
    source,
    evidence: [...candidate.evidence],
    estimatedValueCents: candidate.estimatedValueCents,
    estimatedEffort: candidate.estimatedEffort,
    riskLevel: candidate.riskLevel,
    confidence: candidate.confidence,
    requiresExternalAction: candidate.requiresExternalAction,
  };
}

function persistCandidates(
  db: DiscoveryDatabase,
  candidates: OpportunityInput[],
): Pick<OpportunityDiscoveryResult, "inserted" | "duplicatesSkipped" | "insertedIds"> {
  // Re-read active titles within the transaction and include titles inserted in this run.
  // Unexpected persistence failures roll back the entire batch rather than being skipped.
  return db.runTransaction(() => {
    const activeStatuses = ["discovered", "shortlisted"] as const;
    const titles = new Set(
      activeStatuses.flatMap((status) =>
        db.listOpportunities({ status })
          .map((opportunity) => normalizeOpportunityTitle(opportunity.title)),
      ),
    );
    let duplicatesSkipped = 0;
    const insertedIds: string[] = [];
    for (const candidate of candidates) {
      const title = normalizeOpportunityTitle(candidate.title);
      if (titles.has(title)) {
        duplicatesSkipped++;
        continue;
      }
      insertedIds.push(db.insertOpportunity(candidate).id);
      titles.add(title);
    }
    return { inserted: insertedIds.length, duplicatesSkipped, insertedIds };
  });
}

/**
 * Generate once, inspect only the first three candidates, then persist atomically.
 * Invalid/duplicate candidates do not cause retries or backfilling beyond the bound.
 * Generator errors propagate before any database mutation.
 * requiresExternalAction remains metadata; this API never creates goals or tasks.
 */
export async function discoverOpportunities(
  db: DiscoveryDatabase,
  input: OpportunityDiscoveryInput,
  generator: OpportunityCandidateGenerator,
): Promise<OpportunityDiscoveryResult> {
  validateDiscoveryInput(input);
  // Snapshot input so a generator cannot replace the supplied source identifier.
  const snapshot = { ...input };
  const generated = await generator({ ...snapshot });
  if (!Array.isArray(generated)) throw new Error("Candidate generator must return an array");
  const candidates: OpportunityInput[] = [];
  let invalidSkipped = 0;
  for (const value of generated.slice(0, MAX_DISCOVERY_CANDIDATES)) {
    const candidate = prepareCandidate(value, snapshot.source);
    if (candidate) candidates.push(candidate);
    else invalidSkipped++;
  }
  return {
    generated: generated.length,
    invalidSkipped,
    limitSkipped: Math.max(0, generated.length - MAX_DISCOVERY_CANDIDATES),
    ...persistCandidates(db, candidates),
  };
}
