import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createDatabase } from "../state/database.js";
import { evaluateOpportunity, rankDiscoveredOpportunities, shortlistTopOpportunities } from "../opportunities/evaluation.js";
import { createInferenceClient } from "../conway/inference.js";
import { createQwenOpportunityGenerator } from "../opportunities/qwen-generator.js";
import type { AutomatonDatabase, Opportunity, OpportunityInput } from "../types.js";

vi.mock("../conway/inference.js", () => ({ createInferenceClient: vi.fn(() => { throw new Error("Inference forbidden"); }) }));
vi.mock("../opportunities/qwen-generator.js", () => ({ createQwenOpportunityGenerator: vi.fn(() => { throw new Error("Qwen forbidden"); }) }));

const baseline: Opportunity = {
  id: "baseline", title: "Internal analysis", description: "Review local observations",
  source: "test", status: "discovered", evidence: [], estimatedValueCents: 1000,
  estimatedEffort: "medium", riskLevel: "medium", confidence: 0.5,
  requiresExternalAction: false, createdAt: "2026-01-01T00:00:00.000Z",
  reviewedAt: null, convertedGoalId: null,
};

describe("Deterministic opportunity scoring", () => {
  it("returns explainable points and is independent of text content", () => {
    const result = evaluateOpportunity(baseline);
    expect(result.score).toBe(47.5);
    expect(result.components).toEqual({ value: 10, confidence: 17.5, effort: 12, risk: 8, externalActionPenalty: 0 });
    expect(result.reasons).toHaveLength(5);
    const reworded = { ...baseline, title: "Other wording", evidence: ["Other evidence"] };
    expect(evaluateOpportunity(reworded)).toEqual(result);
  });

  it("rewards higher confidence", () => {
    expect(evaluateOpportunity({ ...baseline, confidence: 0.9 }).score).toBeGreaterThan(evaluateOpportunity(baseline).score);
  });

  it("rewards lower effort and treats unknown conservatively", () => {
    const scores = ["unknown", "high", "medium", "low"].map((estimatedEffort) =>
      evaluateOpportunity({ ...baseline, estimatedEffort: estimatedEffort as Opportunity["estimatedEffort"] }).score,
    );
    expect(scores[0]).toBeLessThan(scores[1]);
    expect(scores[1]).toBeLessThan(scores[2]);
    expect(scores[2]).toBeLessThan(scores[3]);
  });

  it("rewards lower risk", () => {
    const high = evaluateOpportunity({ ...baseline, riskLevel: "high" }).score;
    const medium = evaluateOpportunity(baseline).score;
    const low = evaluateOpportunity({ ...baseline, riskLevel: "low" }).score;
    expect(high).toBeLessThan(medium);
    expect(medium).toBeLessThan(low);
  });

  it.each([[0, 0], [1, 5], [999, 5], [1000, 10], [9999, 10], [10000, 20], [99999, 20], [100000, 30], [Number.MAX_SAFE_INTEGER, 30]])(
    "bounds value %s cents to %s points", (estimatedValueCents, points) => {
      expect(evaluateOpportunity({ ...baseline, estimatedValueCents }).components.value).toBe(points);
    },
  );

  it("applies a five-point external-action penalty without changing safety metadata", () => {
    const external = { ...baseline, requiresExternalAction: true };
    expect(evaluateOpportunity(external).score).toBe(evaluateOpportunity(baseline).score - 5);
    expect(evaluateOpportunity(external).components.externalActionPenalty).toBe(5);
    expect(external.requiresExternalAction).toBe(true);
  });

  it("caps extreme scores within 0–100", () => {
    expect(evaluateOpportunity({ ...baseline, estimatedValueCents: 0, confidence: 0, estimatedEffort: "unknown", riskLevel: "high", requiresExternalAction: true }).score).toBe(0);
    expect(evaluateOpportunity({ ...baseline, estimatedValueCents: Number.MAX_SAFE_INTEGER, confidence: 1, estimatedEffort: "low", riskLevel: "low" }).score).toBe(100);
  });

  it.each([{ confidence: NaN }, { confidence: 1.1 }, { estimatedValueCents: -1 }])("rejects invalid scoring fields %j", (invalid) => {
    expect(() => evaluateOpportunity({ ...baseline, ...invalid })).toThrow("Invalid opportunity scoring fields");
  });
});

describe("Opportunity ranking and review-only shortlisting", () => {
  let directory: string;
  let db: AutomatonDatabase;
  const insert = (id: string, fields: Partial<OpportunityInput> = {}) => db.insertOpportunity({ ...baseline, id, ...fields });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-evaluation-"));
    db = createDatabase(path.join(directory, "test.db"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("ranks by score, confidence, older instant, then ID, repeatedly without mutation", () => {
    insert("z-high", { confidence: 1 });
    insert("confidence", { confidence: 0.5001, createdAt: "2030-01-01T00:00:00Z" });
    insert("later", { createdAt: "2026-01-01T00:00:00Z" });
    insert("b", { createdAt: "2025-12-31T22:00:00Z" });
    insert("a", { createdAt: "2026-01-01T00:00:00+02:00" });
    const before = db.listOpportunities();
    const ranking = rankDiscoveredOpportunities(db);
    expect(ranking.map((entry) => entry.opportunityId)).toEqual(["z-high", "confidence", "a", "b", "later"]);
    expect(rankDiscoveredOpportunities(db)).toEqual(ranking);
    expect(db.listOpportunities()).toEqual(before);
  });

  it("evaluates only discovered rows and preserves all other statuses", () => {
    insert("discovered");
    insert("shortlisted");
    insert("rejected");
    insert("converted");
    db.updateOpportunityReview("shortlisted", { status: "shortlisted" });
    db.updateOpportunityReview("rejected", { status: "rejected" });
    db.updateOpportunityReview("converted", { status: "shortlisted" });
    db.updateOpportunityReview("converted", { status: "converted", convertedGoalId: "logical-goal" });
    const others = ["shortlisted", "rejected", "converted"].map((id) => db.getOpportunityById(id));
    expect(rankDiscoveredOpportunities(db).map((entry) => entry.opportunityId)).toEqual(["discovered"]);
    expect(shortlistTopOpportunities(db, 5).map((entry) => entry.opportunityId)).toEqual(["discovered"]);
    expect(["shortlisted", "rejected", "converted"].map((id) => db.getOpportunityById(id))).toEqual(others);
  });

  it("defaults to three and persists review timestamps while retaining external-action flags", () => {
    for (let index = 0; index < 5; index++) insert(`idea-${index}`, { requiresExternalAction: true });
    const ranking = rankDiscoveredOpportunities(db);
    expect(shortlistTopOpportunities(db)).toEqual(ranking.slice(0, 3));
    for (const { opportunityId } of ranking.slice(0, 3)) {
      expect(db.getOpportunityById(opportunityId)).toMatchObject({ status: "shortlisted", requiresExternalAction: true, reviewedAt: expect.any(String), convertedGoalId: null });
    }
    expect(rankDiscoveredOpportunities(db)).toHaveLength(2);
  });

  it("honors explicit limits, including zero, and never returns more than available", () => {
    for (let index = 0; index < 6; index++) insert(`idea-${index}`);
    expect(shortlistTopOpportunities(db, 0)).toEqual([]);
    expect(shortlistTopOpportunities(db, 1)).toHaveLength(1);
    expect(shortlistTopOpportunities(db, 4)).toHaveLength(4);
    expect(shortlistTopOpportunities(db, 10)).toHaveLength(1);
    expect(shortlistTopOpportunities(db)).toEqual([]);
  });

  it.each([-1, 1.5, NaN, Infinity])("rejects invalid limit %s without changes", (limit) => {
    insert("candidate");
    expect(() => shortlistTopOpportunities(db, limit)).toThrow("non-negative integer");
    expect(db.getOpportunityById("candidate")?.status).toBe("discovered");
  });

  it("rolls back all review changes when a later transition fails", () => {
    insert("a");
    insert("b");
    const before = db.listOpportunities();
    const review = db.updateOpportunityReview;
    vi.spyOn(db, "updateOpportunityReview").mockImplementationOnce(review)
      .mockImplementationOnce(() => { throw new Error("Review failure"); });
    expect(() => shortlistTopOpportunities(db, 2)).toThrow("Review failure");
    expect(db.listOpportunities()).toEqual(before);
  });

  it("never invokes models, network or external execution and creates no goal/task/event", () => {
    const fetch = vi.fn(() => { throw new Error("Network forbidden"); });
    vi.stubGlobal("fetch", fetch);
    insert("candidate", { requiresExternalAction: true });
    rankDiscoveredOpportunities(db);
    shortlistTopOpportunities(db);
    expect(fetch).not.toHaveBeenCalled();
    expect(createInferenceClient).not.toHaveBeenCalled();
    expect(createQwenOpportunityGenerator).not.toHaveBeenCalled();
    for (const table of ["goals", "task_graph", "event_stream", "transactions"]) {
      expect(db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });
});
