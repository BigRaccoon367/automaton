import { discoverOpportunities } from "./discovery.js";
import type { OpportunityCandidateGenerator } from "./discovery.js";
import {
  MAX_ONLINE_OBSERVATIONS, MAX_OBSERVATION_TEXT, UNTRUSTED_EVIDENCE_CONTEXT,
} from "./observation-source.js";
import type { OpportunityObservation, OpportunityObservationSource } from "./observation-source.js";

export interface OnlineDiscoveryFailure {
  stage: "collection" | "discovery";
  observationIndex?: number;
  source?: string;
  message: string;
}

export interface OnlineDiscoveryResult {
  observationsCollected: number;
  observationsSkipped: number;
  generated: number;
  inserted: number;
  duplicatesSkipped: number;
  invalidSkipped: number;
  limitSkipped: number;
  insertedIds: string[];
  failures: OnlineDiscoveryFailure[];
}

/** Manual-only collection. Collection failures stop; observation errors are recorded and processing continues.
 * Each discoverOpportunities call keeps its existing transaction semantics. Earlier successful
 * observations remain persisted if a later observation fails; there is no run-wide transaction.
 */
export async function discoverOnlineOpportunities(
  db: Parameters<typeof discoverOpportunities>[0],
  source: OpportunityObservationSource,
  generator: OpportunityCandidateGenerator,
): Promise<OnlineDiscoveryResult> {
  const result: OnlineDiscoveryResult = {
    observationsCollected: 0, observationsSkipped: 0, generated: 0, inserted: 0,
    duplicatesSkipped: 0, invalidSkipped: 0, limitSkipped: 0, insertedIds: [], failures: [],
  };
  let observations: OpportunityObservation[];
  try {
    observations = await source.collect();
    if (!Array.isArray(observations)) throw new Error("Observation source must return an array");
  } catch (error) {
    result.failures.push({ stage: "collection", message: error instanceof Error ? error.message : "Observation collection failed" });
    return result;
  }
  const bounded = observations.slice(0, MAX_ONLINE_OBSERVATIONS);
  result.observationsCollected = bounded.length;
  result.observationsSkipped = observations.length - bounded.length;
  for (const [index, observation] of bounded.entries()) {
    try {
      if (!observation || typeof observation.source !== "string" || observation.source.length > 256 ||
          typeof observation.observationText !== "string" ||
          (observation.context !== undefined && typeof observation.context !== "string")) {
        throw new Error("Invalid online observation");
      }
      const discovered = await discoverOpportunities(db, {
        source: observation.source,
        observationText: observation.observationText.slice(0, MAX_OBSERVATION_TEXT),
        timestamp: observation.timestamp,
        context: `${UNTRUSTED_EVIDENCE_CONTEXT}\n${observation.context ?? ""}`.slice(0, 500),
      }, generator);
      result.generated += discovered.generated;
      result.inserted += discovered.inserted;
      result.duplicatesSkipped += discovered.duplicatesSkipped;
      result.invalidSkipped += discovered.invalidSkipped;
      result.limitSkipped += discovered.limitSkipped;
      result.insertedIds.push(...discovered.insertedIds);
    } catch (error) {
      result.failures.push({
        stage: "discovery", observationIndex: index,
        source: typeof observation?.source === "string" ? observation.source.slice(0, 256) : undefined,
        message: error instanceof Error ? error.message : "Observation discovery failed",
      });
    }
  }
  return result;
}
