import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createDatabase } from "../state/database.js";
import { discoverOpportunities } from "../opportunities/discovery.js";
import type { OpportunityCandidate, OpportunityDiscoveryInput } from "../opportunities/discovery.js";
import type { AutomatonDatabase } from "../types.js";

const input: OpportunityDiscoveryInput = {
  source: "local-notes",
  observationText: "Users need clearer documentation.",
  timestamp: "2026-10-04T00:00:00.000Z",
  context: "Supplied observations only",
};

function candidate(overrides: Partial<OpportunityCandidate> = {}): OpportunityCandidate {
  return {
    title: "Documentation experiment",
    description: "Evaluate a documentation improvement after review.",
    evidence: ["Local user feedback", "reference:notes/idea"],
    estimatedValueCents: 1000,
    estimatedEffort: "low",
    riskLevel: "low",
    confidence: 0.8,
    requiresExternalAction: false,
    ...overrides,
  };
}

describe("Bounded opportunity discovery", () => {
  let directory: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-discovery-"));
    db = createDatabase(path.join(directory, "test.db"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("persists a generated candidate and passes observations to the generator once", async () => {
    const generator = vi.fn(async () => [candidate()]);
    const result = await discoverOpportunities(db, input, generator);
    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator).toHaveBeenCalledWith(input);
    expect(result).toEqual({
      generated: 1, inserted: 1, duplicatesSkipped: 0, invalidSkipped: 0,
      limitSkipped: 0, insertedIds: [expect.any(String)],
    });
    expect(db.getOpportunityById(result.insertedIds[0])).toMatchObject({
      ...candidate(), source: input.source, status: "discovered",
      reviewedAt: null, convertedGoalId: null,
    });
  });

  it("examines at most three returned candidates and reports the excess", async () => {
    const result = await discoverOpportunities(db, input, async () =>
      Array.from({ length: 5 }, (_, index) => candidate({ title: `Idea ${index}` })),
    );
    expect(result).toMatchObject({ generated: 5, inserted: 3, limitSkipped: 2 });
    expect(db.listOpportunities().map((row) => row.title).sort()).toEqual(["Idea 0", "Idea 1", "Idea 2"]);
  });

  it.each([
    null, "text", [], {}, { title: " " }, { description: " " },
    { confidence: -0.1 }, { confidence: 1.1 }, { confidence: NaN }, { confidence: Infinity },
    { estimatedValueCents: -1 }, { estimatedValueCents: 1.5 },
    { evidence: "reference" }, { evidence: [1] }, { evidence: null },
    { estimatedEffort: "unsupported" }, { riskLevel: "safe" },
    { requiresExternalAction: "false" },
  ])("skips malformed candidate %j", async (invalid) => {
    const value = invalid === null || typeof invalid !== "object" || Array.isArray(invalid)
      ? invalid
      : Object.keys(invalid).length === 0 ? invalid : { ...candidate(), ...invalid };
    const result = await discoverOpportunities(db, input, async () => [value, candidate()] as OpportunityCandidate[]);
    expect(result).toMatchObject({ generated: 2, inserted: 1, invalidSkipped: 1 });
  });

  it("does not backfill invalid candidates beyond the first three", async () => {
    const result = await discoverOpportunities(db, input, async () => [
      candidate({ title: " " }), candidate({ title: "A" }), candidate({ title: "B" }), candidate({ title: "C" }),
    ]);
    expect(result).toMatchObject({ generated: 4, inserted: 2, invalidSkipped: 1, limitSkipped: 1 });
  });

  it("filters normalized duplicates within one run and across runs", async () => {
    const result = await discoverOpportunities(db, input, async () => [
      candidate({ title: "  Documentation   Experiment  " }),
      candidate({ title: "documentation\tEXPERIMENT" }),
      candidate({ title: "Documentation\nexperiment" }),
    ]);
    expect(result).toMatchObject({ inserted: 1, duplicatesSkipped: 2 });
    expect((await discoverOpportunities(db, { ...input, source: "other-source" }, async () => [candidate()])).duplicatesSkipped).toBe(1);
    expect(db.listOpportunities()).toHaveLength(1);
  });

  it.each(["discovered", "shortlisted"] as const)("deduplicates existing %s candidates", async (status) => {
    const existing = db.insertOpportunity({ ...candidate(), source: "prior" });
    if (status === "shortlisted") db.updateOpportunityReview(existing.id, { status });
    const result = await discoverOpportunities(db, input, async () => [candidate()]);
    expect(result).toMatchObject({ inserted: 0, duplicatesSkipped: 1 });
    expect(db.getOpportunityById(existing.id)?.status).toBe(status);
  });

  it.each(["rejected", "converted"] as const)("allows rediscovery after %s", async (status) => {
    const existing = db.insertOpportunity({ ...candidate(), source: "prior" });
    if (status === "converted") db.updateOpportunityReview(existing.id, { status: "shortlisted" });
    db.updateOpportunityReview(existing.id, { status });
    expect((await discoverOpportunities(db, input, async () => [candidate()])).inserted).toBe(1);
    expect(db.listOpportunities()).toHaveLength(2);
  });

  it("stores external-action metadata without network, goal, task or event creation", async () => {
    const fetch = vi.fn(() => { throw new Error("Network unavailable"); });
    vi.stubGlobal("fetch", fetch);
    const result = await discoverOpportunities(db, input, async () => [candidate({ requiresExternalAction: true })]);
    expect(db.getOpportunityById(result.insertedIds[0])?.requiresExternalAction).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    for (const table of ["goals", "task_graph", "event_stream", "transactions"]) {
      expect(db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("preserves existing opportunities when the generator fails", async () => {
    db.insertOpportunity({ ...candidate(), source: "prior" });
    const before = db.listOpportunities();
    const insert = vi.spyOn(db, "insertOpportunity");
    await expect(discoverOpportunities(db, input, async () => { throw new Error("Generator failed"); }))
      .rejects.toThrow("Generator failed");
    expect(insert).not.toHaveBeenCalled();
    expect(db.listOpportunities()).toEqual(before);
  });

  it("rolls back the batch if persistence fails after the first insertion", async () => {
    db.insertOpportunity({ ...candidate(), source: "prior" });
    const before = db.listOpportunities();
    const insert = db.insertOpportunity;
    vi.spyOn(db, "insertOpportunity")
      .mockImplementationOnce(insert)
      .mockImplementationOnce(() => { throw new Error("Storage failed"); });
    await expect(discoverOpportunities(db, input, async () => [candidate({ title: "A" }), candidate({ title: "B" })]))
      .rejects.toThrow("Storage failed");
    expect(db.listOpportunities()).toEqual(before);
  });

  it("does not let generator-supplied lifecycle fields or source bypass discovery", async () => {
    const result = await discoverOpportunities(db, input, async (observation) => {
      observation.source = "mutated";
      return [{ ...candidate(), source: "forged", status: "converted", id: "forged-id", convertedGoalId: "goal" }];
    });
    expect(db.getOpportunityById(result.insertedIds[0])).toMatchObject({
      source: input.source, status: "discovered", convertedGoalId: null,
    });
    expect(result.insertedIds[0]).not.toBe("forged-id");
  });

  it("returns zero counts for empty output and rejects non-array output", async () => {
    expect(await discoverOpportunities(db, input, async () => [])).toEqual({
      generated: 0, inserted: 0, duplicatesSkipped: 0, invalidSkipped: 0, limitSkipped: 0, insertedIds: [],
    });
    await expect(discoverOpportunities(db, input, async () => null as unknown as OpportunityCandidate[]))
      .rejects.toThrow("must return an array");
    expect(db.listOpportunities()).toEqual([]);
  });

  it.each([{ source: " " }, { observationText: " " }, { timestamp: "bad-date" }, { context: 1 }])(
    "rejects invalid observations before generation %j", async (invalid) => {
      const generator = vi.fn(async () => [candidate()]);
      await expect(discoverOpportunities(db, { ...input, ...invalid } as OpportunityDiscoveryInput, generator)).rejects.toThrow();
      expect(generator).not.toHaveBeenCalled();
      expect(db.listOpportunities()).toEqual([]);
    },
  );
});
