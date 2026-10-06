import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createDatabase } from "../state/database.js";
import { createRevenueExperimentReviewer } from "../opportunities/revenue-reviewer.js";
import { checkRevenueExperimentDraft, getRevenueExperimentReview, saveRevenueExperimentReview, REVIEW_FINDING_FIELDS } from "../opportunities/revenue-review.js";
import type { RevenueExperimentReview } from "../opportunities/revenue-review.js";
import type { InferenceClient, Opportunity, RevenueExperimentPlan, RevenueExperimentPlanRecord } from "../types.js";

const opportunity: Opportunity = {
  id: "op", title: "Manual reports", description: "Five small accounting firms report manual weekly reporting delays.",
  evidence: ["Five firms report delays; no existing user base."], source: "local", status: "shortlisted",
  estimatedValueCents: 10000, estimatedEffort: "low", riskLevel: "low", confidence: 0.7,
  requiresExternalAction: false, createdAt: "2026-01-01", reviewedAt: null, convertedGoalId: null,
};
const plan: RevenueExperimentPlan = {
  opportunityId: "op", problem: "Manual weekly reporting delays", customer: "Small accounting firms with weekly reports",
  offer: "Our report template drafting service", channel: "Human-selected accounting firm interviews",
  proposedPriceCents: 1500, revenueModel: "Test price per template", experiment: "Contact 5 firms to test demand at $15",
  successMetric: "At least 3 of 5 firms express willingness to pay $15", estimatedCostCents: 0,
  riskLevel: "low", requiresExternalAction: true, status: "draft",
};
const record: RevenueExperimentPlanRecord = { id: "plan", plan, createdAt: "2026-01-01" };
const approved: RevenueExperimentReview = {
  planId: "forged", decision: "approve_for_human_review", score: 80,
  findings: Object.fromEntries(REVIEW_FINDING_FIELDS.map((key) => [key, "Supported for human review; no execution approval."])) as RevenueExperimentReview["findings"],
  unsupportedAssumptions: [], revisionSuggestions: [], requiresHumanApproval: true, requiresExternalAction: false,
};
function fake(output: unknown = approved) {
  const chat = vi.fn<InferenceClient["chat"]>(async () => ({ id: "fake", model: "fake", finishReason: "stop",
    message: { role: "assistant", content: typeof output === "string" ? output : JSON.stringify(output) },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }));
  return { chat, reviewer: createRevenueExperimentReviewer({ inference: { chat }, providerCapabilities: ["Draft structured report templates from supplied data."] }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Draft review gate", () => {
  it("permits coherent drafts for human review only, with compact no-tool local inference", async () => {
    const { reviewer, chat } = fake();
    const review = await reviewer.reviewDraft(record, opportunity);
    expect(review).toMatchObject({ planId: record.id, decision: "approve_for_human_review", requiresHumanApproval: true, requiresExternalAction: true });
    expect(chat.mock.calls[0][1]).toEqual({ model: "qwen/qwen3-vl-8b", temperature: 0, maxTokens: 2048, tools: [] });
    expect(chat.mock.calls[0][0][0].content).toContain("Skeptically");
  });

  const live: RevenueExperimentPlan = { ...plan,
    customer: "Small to mid-sized businesses with recurring reporting needs, such as marketing teams or project managers.",
    offer: "Customizable weekly report templates generated from user-provided data or prompts, using deterministic output from Raccoon Automaton.",
    channel: "Direct sales via a simple landing page or email outreach to existing users.",
    proposedPriceCents: 1500,
    experiment: "Offer 3 custom report templates to 5 beta users for free, then charge $15 for the next 5 users to test demand.",
    successMetric: "At least 3 paid conversions from the 5th user onward.", requiresExternalAction: false,
  };
  it("forces the exact live weekly-report case to revise even against model approval", async () => {
    const checks = checkRevenueExperimentDraft(live, opportunity);
    expect(checks).toEqual(checkRevenueExperimentDraft(live, opportunity));
    expect(checks.concerns.join(" ")).toMatch(/Existing users.*unsupported/);
    expect(checks.concerns.join(" ")).toContain("broad");
    expect(checks.concerns.join(" ")).toContain("cohort is ambiguous");
    const result = await fake({ ...approved, findings: { ...approved.findings, pricePlausibility: "$15 is a test hypothesis, not validated pricing." } }).reviewer.reviewDraft({ ...record, plan: live }, opportunity);
    expect(result.decision).toBe("revise");
    expect(result.requiresExternalAction).toBe(true);
    expect(result.findings.pricePlausibility).toContain("test hypothesis");
  });

  it.each([{ problem: "" }, { proposedPriceCents: -1 }, { estimatedCostCents: 1.5 }, { status: "running" }])("rejects hard invariants before inference %j", async (invalid) => {
    const { reviewer, chat } = fake();
    const result = await reviewer.reviewDraft({ ...record, plan: { ...plan, ...invalid } as RevenueExperimentPlan }, opportunity);
    expect(result.decision).toBe("reject");
    expect(chat).not.toHaveBeenCalled();
  });

  it("flags a nonmeasurable metric and unsupported validated price", async () => {
    const result = await fake().reviewer.reviewDraft({ ...record, plan: { ...plan, successMetric: "Positive response", revenueModel: "Guaranteed validated market price" } }, opportunity);
    expect(result.decision).toBe("revise");
    expect(result.unsupportedAssumptions.join(" ")).toContain("measurable threshold");
    expect(result.unsupportedAssumptions.join(" ")).toContain("Price certainty");
  });

  it("allows semantic rejection of an unavailable capability", async () => {
    const result = await fake({ ...approved, decision: "reject", findings: { ...approved.findings, offerFeasibility: "No production accounting integration capability supplied." }, unsupportedAssumptions: ["Assumes a production accounting connector"] })
      .reviewer.reviewDraft({ ...record, plan: { ...plan, offer: "Production accounting integration" } }, opportunity);
    expect(result.decision).toBe("reject");
    expect(result.findings.offerFeasibility).toContain("No production");
  });

  it("retains model true and all human gates", async () => {
    const internal = { ...plan, offer: "Internal report draft", channel: "Local records", experiment: "Analyze stored reports", requiresExternalAction: false };
    const result = await fake({ ...approved, requiresExternalAction: true }).reviewer.reviewDraft({ ...record, plan: internal }, opportunity);
    expect(result.requiresExternalAction).toBe(true);
    expect(result.requiresHumanApproval).toBe(true);
  });

  it.each(["invalid JSON", "null", "[]", "{}", JSON.stringify({ ...approved, score: 101 }), JSON.stringify({ ...approved, requiresHumanApproval: false }), JSON.stringify({ ...approved, findings: {} })])("rejects malformed model response %s", async (output) => {
    await expect(fake(output).reviewer.reviewDraft(record, opportunity)).rejects.toThrow();
  });
  it("fails safely on inference errors and tool calls", async () => {
    const { chat, reviewer } = fake();
    chat.mockRejectedValueOnce(new Error("offline"));
    await expect(reviewer.reviewDraft(record, opportunity)).rejects.toThrow("inference failed");
    chat.mockResolvedValueOnce({ id: "fake", model: "fake", message: { role: "assistant", content: "{}" }, finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, toolCalls: [{ id: "1", type: "function", function: { name: "publish", arguments: "{}" } }] });
    await expect(reviewer.reviewDraft(record, opportunity)).rejects.toThrow("tools or truncation");
  });

  it("persists informational reviews without changing draft/opportunity or executing anything", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-review-"));
    const dbPath = path.join(directory, "test.db");
    let db = createDatabase(dbPath);
    const fetch = vi.fn(() => { throw new Error("Network forbidden"); });
    vi.stubGlobal("fetch", fetch);
    try {
      db.insertOpportunity(opportunity);
      const saved = db.insertRevenueExperimentPlan(plan);
      const reviewer = fake().reviewer;
      const result = await reviewer.reviewRevenueExperiment(db, saved.id);
      expect(getRevenueExperimentReview(db, saved.id)).toBeUndefined();
      saveRevenueExperimentReview(db, result);
      expect(getRevenueExperimentReview(db, saved.id)).toEqual(result);
      expect(() => saveRevenueExperimentReview(db, { ...result, planId: "missing" })).toThrow("persisted draft");
      db.close(); db = createDatabase(dbPath);
      expect(getRevenueExperimentReview(db, saved.id)).toEqual(result);
      expect(db.getRevenueExperimentPlanById(saved.id)).toEqual(saved);
      expect(db.getOpportunityById(opportunity.id)).toEqual(opportunity);
      for (const table of ["goals", "task_graph", "event_stream", "transactions"]) expect(db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      expect(fetch).not.toHaveBeenCalled();
    } finally { if (db.raw.open) db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
