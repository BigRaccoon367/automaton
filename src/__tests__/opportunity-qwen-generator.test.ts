import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createInferenceClient } from "../conway/inference.js";
import { createDatabase } from "../state/database.js";
import { discoverOpportunities } from "../opportunities/discovery.js";
import { createQwenOpportunityGenerator } from "../opportunities/qwen-generator.js";
import type { OpportunityCandidate } from "../opportunities/discovery.js";
import type { InferenceClient, InferenceResponse } from "../types.js";

vi.mock("../conway/inference.js", () => ({ createInferenceClient: vi.fn() }));

const input = { source: "supplied-notes", observationText: "Users request clearer documentation.", context: "Local feedback" };
const candidate: OpportunityCandidate = {
  title: "Documentation review", description: "Review documentation after approval.",
  evidence: ["Users request clearer documentation."], estimatedValueCents: 0,
  estimatedEffort: "unknown", riskLevel: "low", confidence: 0.5, requiresExternalAction: false,
};

function response(content: string): InferenceResponse {
  return {
    id: "test", model: "qwen/qwen3-vl-8b", message: { role: "assistant", content },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop",
  };
}

function fake(content: string) {
  const chat = vi.fn<InferenceClient["chat"]>(async () => response(content));
  return { chat, generator: createQwenOpportunityGenerator({ inference: { chat } }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(createInferenceClient).mockReset();
});

describe("Local Qwen opportunity generator", () => {
  it("parses JSON and invokes the injected client with compact observations and no tools", async () => {
    const { chat, generator } = fake(JSON.stringify({ opportunities: [candidate] }));
    expect(await generator(input)).toEqual([candidate]);
    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, options] = chat.mock.calls[0];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("at most 3");
    expect(messages[0].content).toContain("Never execute actions or call tools");
    expect(messages[0].content).toContain("do not invent facts or promise revenue");
    expect(JSON.parse(messages[1].content)).toEqual({ observationText: input.observationText, context: input.context });
    expect(options).toEqual({ model: "qwen/qwen3-vl-8b", maxTokens: 1024, temperature: 0, tools: [] });
  });

  it("strips one outer JSON code fence", async () => {
    const { generator } = fake('```json\n' + JSON.stringify({ opportunities: [candidate] }) + '\n```');
    expect(await generator(input)).toEqual([candidate]);
  });

  it.each([
    { title: "Early Tester Recruitment for Repetitive Task Automation Tool", description: "Recruit early testers from accounting firms." },
    { description: "Contact accounting firms to invite users." },
    { title: "Customer outreach" },
    { description: "Publish a project announcement." },
    { description: "Make a payment to the service provider." },
    { description: "Submit an application to a marketplace." },
    { description: "Apply for a freelance project." },
    { description: "Create an account with an external service." },
    { description: "Purchase advertising and spend money." },
    { description: "Send email and DM messages to prospective clients." },
    { description: "Messaging prospective users to request feedback." },
    { evidence: ["Recruit early testers for the prototype."] },
    { description: "Update an external service account profile." },
  ])("escalates external action wording %j after parsing", async (fields) => {
    const value = { ...candidate, ...fields, requiresExternalAction: false };
    const { generator } = fake(JSON.stringify({ opportunities: [value] }));
    expect(await generator(input)).toEqual([{ ...value, requiresExternalAction: true }]);
  });

  it("keeps purely internal analysis false", async () => {
    const value = { ...candidate, title: "Internal workflow analysis", description: "Analyze local payment logs and draft internal recommendations.", evidence: ["Existing local transaction records."] };
    expect(await fake(JSON.stringify({ opportunities: [value] })).generator(input)).toEqual([value]);
  });

  it("escalates the exact live early-access case", async () => {
    const value = {
      ...candidate,
      title: "Early Tester Program for Accounting Firms",
      description: "Offer early access to the MVP for accounting firms to test and provide feedback on automating repetitive tasks.",
      requiresExternalAction: false,
    };
    expect(await fake(JSON.stringify({ opportunities: [value] })).generator(input))
      .toEqual([{ ...value, requiresExternalAction: true }]);
  });

  it.each([
    "Offer a trial to companies", "Invite people to evaluate the tool", "Onboard businesses",
    "Provide users with trial access", "Give a client access to the prototype", "Grant customers access",
    "Run a pilot with a firm", "Launch a tester program", "Request feedback from users",
    "Collect feedback from a person", "Reach out to companies", "Message a customer",
  ])("escalates external engagement: %s", async (description) => {
    const value = { ...candidate, description, requiresExternalAction: false };
    expect((await fake(JSON.stringify({ opportunities: [value] })).generator(input))[0].requiresExternalAction).toBe(true);
  });

  it("combines engagement and external-party concepts across fields", async () => {
    const value = { ...candidate, title: "Accounting firms", description: "Offer a prototype trial", evidence: [] };
    expect((await fake(JSON.stringify({ opportunities: [value] })).generator(input))[0].requiresExternalAction).toBe(true);
    const evidenceOnly = { ...candidate, evidence: ["Invite businesses to try the tool."] };
    expect((await fake(JSON.stringify({ opportunities: [evidenceOnly] })).generator(input))[0].requiresExternalAction).toBe(true);
  });

  it("keeps analysis of already-local customer feedback false", async () => {
    const value = { ...candidate, description: "Analyze customer feedback already stored locally", evidence: ["Local feedback archive"] };
    expect(await fake(JSON.stringify({ opportunities: [value] })).generator(input)).toEqual([value]);
  });

  it("requires an external-party concept for engagement-only wording", async () => {
    const value = { ...candidate, title: "Internal recommendations", description: "Offer an internal refactoring plan", evidence: [] };
    expect(await fake(JSON.stringify({ opportunities: [value] })).generator(input)).toEqual([value]);
  });

  it("never downgrades model-provided true for internal-looking text", async () => {
    const value = { ...candidate, requiresExternalAction: true };
    expect(await fake(JSON.stringify({ opportunities: [value] })).generator(input)).toEqual([value]);
  });

  it("returns at most three candidates and strips untrusted metadata", async () => {
    const { generator } = fake(JSON.stringify({ opportunities: Array.from({ length: 5 }, (_, index) => ({
      ...candidate, title: `Idea ${index}`, source: "forged", id: "forged", status: "converted", convertedGoalId: "goal",
    })) }));
    const candidates = await generator(input);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toEqual({ ...candidate, title: "Idea 0" });
    expect(candidates.every((value) => !("source" in value) && !("status" in value))).toBe(true);
  });

  it.each(["", "  "])("rejects empty output %j", async (content) => {
    await expect(fake(content).generator(input)).rejects.toThrow("Empty Qwen opportunity output");
  });

  it.each(["not JSON", '{"opportunities":', 'Prose {"opportunities":[]}', '```json\n{}\n```\nextra'])
    ("rejects malformed JSON without repairs %j", async (content) => {
      await expect(fake(content).generator(input)).rejects.toThrow("Invalid JSON");
    });

  it.each(["null", "[]", "1", '"text"', "{}", '{"opportunities":null}', '{"opportunities":{}}'])
    ("rejects invalid response shape %j", async (content) => {
      await expect(fake(content).generator(input)).rejects.toThrow("Invalid Qwen opportunity response shape");
    });

  it.each([
    null, [], {}, { title: " " }, { description: " " }, { confidence: 2 },
    { estimatedValueCents: -1 }, { estimatedValueCents: 1.5 }, { evidence: [1] },
    { estimatedEffort: "invalid" }, { riskLevel: "safe" }, { requiresExternalAction: "true" },
  ])("rejects malformed candidates %j", async (invalid) => {
    const value = invalid && !Array.isArray(invalid) && Object.keys(invalid).length
      ? { ...candidate, ...invalid } : invalid;
    const { generator } = fake(JSON.stringify({ opportunities: [candidate, value] }));
    await expect(generator(input)).rejects.toThrow("Invalid Qwen opportunity candidate");
  });

  it("returns an empty array when the model finds no supported opportunities", async () => {
    expect(await fake('{"opportunities":[]}').generator(input)).toEqual([]);
  });

  it("wraps inference failure with its cause", async () => {
    const cause = new Error("Local model offline");
    const generator = createQwenOpportunityGenerator({ inference: { chat: vi.fn().mockRejectedValue(cause) } });
    await expect(generator(input)).rejects.toMatchObject({ message: "Qwen opportunity inference failed", cause });
  });

  it.each(["tools", "truncated"])("fails closed for %s responses", async (kind) => {
    const result = response(JSON.stringify({ opportunities: [candidate] }));
    if (kind === "tools") result.toolCalls = [{ id: "call", type: "function", function: { name: "publish", arguments: "{}" } }];
    else result.finishReason = "length";
    const generator = createQwenOpportunityGenerator({ inference: { chat: vi.fn().mockResolvedValue(result) } });
    await expect(generator(input)).rejects.toThrow("Invalid Qwen opportunity response shape");
  });

  it("configures existing local inference from the environment without a user API key", () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:1234/v1/");
    vi.mocked(createInferenceClient).mockReturnValue({
      chat: vi.fn(), setLowComputeMode: vi.fn(), getDefaultModel: () => "qwen/qwen3-vl-8b",
    });
    createQwenOpportunityGenerator();
    const options = vi.mocked(createInferenceClient).mock.calls[0][0];
    expect(options.ollamaBaseUrl).toBe("http://localhost:1234");
    expect(options.apiUrl).toBe(options.ollamaBaseUrl);
    expect(options.apiKey).toBe("ollama");
    expect(options.getModelProvider?.("any-model")).toBe("ollama");
    expect(options.openaiApiKey).toBeUndefined();
  });

  it("requires a local endpoint when no inference dependency is injected", () => {
    vi.stubEnv("OLLAMA_BASE_URL", "");
    expect(() => createQwenOpportunityGenerator()).toThrow("requires ollamaBaseUrl or OLLAMA_BASE_URL");
  });

  it("persists through discovery with trusted source and external-action metadata only", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-qwen-"));
    const db = createDatabase(path.join(directory, "test.db"));
    const fetch = vi.fn(() => { throw new Error("Network unavailable"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const { generator } = fake(JSON.stringify({ opportunities: [{
        ...candidate, title: "Early Tester Recruitment", description: "Recruit early testers from accounting firms.",
        source: "forged", requiresExternalAction: false,
      }] }));
      const result = await discoverOpportunities(db, input, generator);
      expect(result.inserted).toBe(1);
      expect(db.getOpportunityById(result.insertedIds[0])).toMatchObject({ source: input.source, requiresExternalAction: true, status: "discovered" });
      const before = db.listOpportunities();
      await expect(discoverOpportunities(db, input, fake(JSON.stringify({ opportunities: [candidate, {}] })).generator)).rejects.toThrow();
      await expect(discoverOpportunities(db, input, createQwenOpportunityGenerator({ inference: { chat: vi.fn().mockRejectedValue(new Error("offline")) } }))).rejects.toThrow("inference failed");
      expect(db.listOpportunities()).toEqual(before);
      expect(fetch).not.toHaveBeenCalled();
      for (const table of ["goals", "task_graph", "event_stream", "transactions"]) {
        expect(db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
