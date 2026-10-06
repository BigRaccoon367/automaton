import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createInferenceClient } from "../conway/inference.js";
import { createRevenueExperimentPlanner } from "../opportunities/revenue-planner.js";
import { createDatabase } from "../state/database.js";
import type { InferenceClient, InferenceResponse, Opportunity, RevenueExperimentPlan } from "../types.js";

vi.mock("../conway/inference.js", () => ({ createInferenceClient: vi.fn() }));

const opportunity: Opportunity = {
  id: "selected", title: "Manual spreadsheet reconciliation", description: "Accounting firms report slow manual reconciliation.",
  source: "test", status: "shortlisted", evidence: ["Manual matching is slow"],
  estimatedValueCents: 10000, estimatedEffort: "low", riskLevel: "low", confidence: 0.7,
  requiresExternalAction: false, createdAt: "2026-01-01T00:00:00Z", reviewedAt: null, convertedGoalId: null,
};
const proposal = {
  problem: "Manual matching of spreadsheet exports is slow.", customer: "Small accounting firms with manual reconciliation work.",
  offer: "Our spreadsheet reconciliation review and recommendations.", channel: "Internal analysis of local sample records.",
  proposedPriceCents: 10000, revenueModel: "Fixed price per review", experiment: "Analyze local samples and draft one internal report.",
  successMetric: "Report correctly identifies at least 90% of known mismatches in the sample.",
  estimatedCostCents: 0, riskLevel: "low", requiresExternalAction: false,
};
const capabilities = ["Analyze anonymized spreadsheet exports and draft reconciliation recommendations."];

function response(content: string): InferenceResponse {
  return { id: "fake", model: "fake", message: { role: "assistant", content },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
}
function fake(value: unknown) {
  const chat = vi.fn<InferenceClient["chat"]>(async () => response(typeof value === "string" ? value : JSON.stringify(value)));
  return { chat, planner: createRevenueExperimentPlanner({ inference: { chat }, providerCapabilities: capabilities }) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.mocked(createInferenceClient).mockReset(); });

describe("Revenue experiment proposals", () => {
  it("returns a reproducible draft for our own offer, uses trusted ID and no tools", async () => {
    const { chat, planner } = fake({ suitable: true, plan: { ...proposal, opportunityId: "forged", task: "execute" } });
    const result = await planner.planRevenueExperiment(opportunity);
    expect(result).toEqual({ suitable: true, plan: { ...proposal, opportunityId: opportunity.id, status: "draft" } });
    expect(await planner.planRevenueExperiment(opportunity)).toEqual(result);
    const [messages, options] = chat.mock.calls[0];
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("OUR OWN sellable offer");
    expect(messages[0].content).toContain("somebody else's activity");
    expect(JSON.parse(messages[1].content).providerCapabilities).toEqual(capabilities);
    expect(options).toEqual({ model: "qwen/qwen3-vl-8b", temperature: 0, maxTokens: 1536, tools: [] });
  });

  it.each(["problem", "customer", "offer", "channel", "revenueModel", "experiment", "successMetric"])("requires %s", async (field) => {
    await expect(fake({ suitable: true, plan: { ...proposal, [field]: " " } }).planner.planRevenueExperiment(opportunity)).rejects.toThrow(field);
    await expect(fake({ suitable: true, plan: { ...proposal, [field]: null } }).planner.planRevenueExperiment(opportunity)).rejects.toThrow(field);
  });

  it.each(["proposedPriceCents", "estimatedCostCents"])("requires nonnegative integer %s", async (field) => {
    for (const value of [-1, 0.5, "100", null]) {
      await expect(fake({ suitable: true, plan: { ...proposal, [field]: value } }).planner.planRevenueExperiment(opportunity)).rejects.toThrow(field);
    }
    expect((await fake({ suitable: true, plan: { ...proposal, [field]: 0 } }).planner.planRevenueExperiment(opportunity)).suitable).toBe(true);
  });

  it("allows do-not-pursue for another startup's request", async () => {
    const reason = "No clear paying customer or our own sellable offer supported by this beta-tester request.";
    const { planner } = fake({ suitable: false, reason });
    expect(await planner.planRevenueExperiment({ ...opportunity, title: "A startup seeks accounting-firm beta testers" }))
      .toEqual({ suitable: false, reason });
  });

  it("rejects the obvious restatement even when Qwen calls it suitable", async () => {
    const result = await fake({ suitable: true, plan: { ...proposal, offer: "Recruit beta testers for that startup." } }).planner.planRevenueExperiment(opportunity);
    expect(result).toMatchObject({ suitable: false, reason: expect.stringContaining("another organization's") });
  });

  it.each([
    "Contact accounting firms and request feedback", "Publish a public announcement",
    "Accept payments from customers", "Process a payment transaction", "Create an external account",
    "Offer early access to accounting firms and collect feedback",
  ])("escalates side-effecting experiment %s", async (experiment) => {
    const result = await fake({ suitable: true, plan: { ...proposal, experiment } }).planner.planRevenueExperiment(opportunity);
    expect(result.suitable && result.plan.requiresExternalAction).toBe(true);
  });

  it("retains model/source true and permits internal-only validation false", async () => {
    const internal = await fake({ suitable: true, plan: proposal }).planner.planRevenueExperiment(opportunity);
    expect(internal.suitable && internal.plan.requiresExternalAction).toBe(false);
    const modelTrue = await fake({ suitable: true, plan: { ...proposal, requiresExternalAction: true } }).planner.planRevenueExperiment(opportunity);
    expect(modelTrue.suitable && modelTrue.plan.requiresExternalAction).toBe(true);
    const sourceTrue = await fake({ suitable: true, plan: proposal }).planner.planRevenueExperiment({ ...opportunity, requiresExternalAction: true });
    expect(sourceTrue.suitable && sourceTrue.plan.requiresExternalAction).toBe(true);
  });

  it.each(["broken JSON", "null", "[]", "{}", '{"suitable":"true"}', '{"suitable":false,"reason":""}'])
    ("rejects malformed output %s", async (value) => { await expect(fake(value).planner.planRevenueExperiment(opportunity)).rejects.toThrow(); });

  it("supports one JSON fence but rejects automatic approval and malformed risk/flags", async () => {
    const text = '```json\n' + JSON.stringify({ suitable: true, plan: proposal }) + '\n```';
    expect((await fake(text).planner.planRevenueExperiment(opportunity)).suitable).toBe(true);
    for (const invalid of [{ status: "approved" }, { riskLevel: "safe" }, { requiresExternalAction: "false" }]) {
      await expect(fake({ suitable: true, plan: { ...proposal, ...invalid } }).planner.planRevenueExperiment(opportunity)).rejects.toThrow();
    }
  });

  it("propagates inference failure and refuses tool responses or truncation", async () => {
    const cause = new Error("offline");
    const chat = vi.fn<InferenceClient["chat"]>().mockRejectedValueOnce(cause);
    const planner = createRevenueExperimentPlanner({ inference: { chat } });
    await expect(planner.planRevenueExperiment(opportunity)).rejects.toMatchObject({ message: "Revenue experiment inference failed", cause });
    const toolResponse = response(JSON.stringify({ suitable: true, plan: proposal }));
    toolResponse.toolCalls = [{ id: "1", type: "function", function: { name: "publish", arguments: "{}" } }];
    chat.mockResolvedValueOnce(toolResponse).mockResolvedValueOnce({ ...response("{}"), finishReason: "length" });
    await expect(planner.planRevenueExperiment(opportunity)).rejects.toThrow("tools or truncated");
    await expect(planner.planRevenueExperiment(opportunity)).rejects.toThrow("tools or truncated");
  });

  it("rejects terminal opportunities without inference", async () => {
    const { planner, chat } = fake({ suitable: true, plan: proposal });
    expect((await planner.planRevenueExperiment({ ...opportunity, status: "rejected" })).suitable).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });

  it("wires local inference through the existing client with no new API key", () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:1234/v1/");
    vi.mocked(createInferenceClient).mockReturnValue({ chat: vi.fn(), setLowComputeMode: vi.fn(), getDefaultModel: () => "fake" });
    createRevenueExperimentPlanner();
    const options = vi.mocked(createInferenceClient).mock.calls[0][0];
    expect(options.ollamaBaseUrl).toBe("http://localhost:1234");
    expect(options.getModelProvider?.("qwen")).toBe("ollama");
    expect(options.apiKey).toBe("ollama");
  });

  it("stores drafts explicitly, survives reopen and V12 upgrade, without goals/tasks or live network", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-revenue-"));
    const dbPath = path.join(directory, "test.db");
    let db = createDatabase(dbPath);
    const fetch = vi.fn(() => { throw new Error("Live network forbidden"); });
    vi.stubGlobal("fetch", fetch);
    try {
      db.insertOpportunity(opportunity);
      db.raw.exec("DROP TABLE revenue_experiment_plans; DELETE FROM schema_version WHERE version >= 13;");
      db.close();
      db = createDatabase(dbPath);
      expect(db.getOpportunityById(opportunity.id)).toEqual(opportunity);
      const result = await fake({ suitable: true, plan: { ...proposal, experiment: "Publish a public announcement" } }).planner.planRevenueExperiment(opportunity);
      expect(db.listRevenueExperimentPlans()).toEqual([]);
      if (!result.suitable) throw new Error("Expected suitable result");
      const saved = db.insertRevenueExperimentPlan(result.plan);
      expect(saved.plan).toMatchObject({ status: "draft", requiresExternalAction: true });
      expect(db.getRevenueExperimentPlanById(saved.id)).toEqual(saved);
      expect(db.getRevenueExperimentPlanById("missing")).toBeUndefined();
      expect(db.listRevenueExperimentPlans(opportunity.id)).toEqual([saved]);
      expect(db.listRevenueExperimentPlans("other")).toEqual([]);
      expect(() => db.insertRevenueExperimentPlan({ ...saved.plan, status: "approved" } as unknown as RevenueExperimentPlan)).toThrow();
      const guarded = db.insertRevenueExperimentPlan({ ...saved.plan, requiresExternalAction: false });
      expect(guarded.plan.requiresExternalAction).toBe(true);
      db.close();
      db = createDatabase(dbPath);
      expect(db.getRevenueExperimentPlanById(saved.id)).toEqual(saved);
      expect(db.getOpportunityById(opportunity.id)).toEqual(opportunity);
      expect(fetch).not.toHaveBeenCalled();
      for (const table of ["goals", "task_graph", "event_stream", "transactions"]) {
        expect(db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      if (db.raw.open) db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
