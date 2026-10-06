import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { createDatabase, insertGoal, getGoalById } from "../state/database.js";
import * as schema from "../state/schema.js";
import type { AutomatonDatabase, OpportunityInput, OpportunityStatus } from "../types.js";

describe("Opportunity persistence", () => {
  let directory: string;
  let dbPath: string;
  let db: AutomatonDatabase;
  const input: OpportunityInput = {
    id: "opportunity-1",
    title: "Documentation experiment",
    description: "Candidate awaiting human review",
    source: "local-review",
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-opportunities-"));
    dbPath = path.join(directory, "test.db");
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (db.raw.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("creates the V12 schema, indexes, and SQL defaults", () => {
    expect(schema.SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
    expect(db.raw.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: schema.SCHEMA_VERSION });
    const indexes = db.raw.pragma("index_list(opportunities)") as { name: string }[];
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_opportunities_status", "idx_opportunities_created_at",
    ]));
    db.raw.prepare("INSERT INTO opportunities (id, title, description, source, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("defaults", "Defaults", "Description", "test", "2026-01-01T00:00:00.000Z");
    expect(db.getOpportunityById("defaults")).toMatchObject({
      status: "discovered", evidence: [], estimatedValueCents: 0,
      estimatedEffort: "unknown", riskLevel: "low", confidence: 0,
      requiresExternalAction: false, reviewedAt: null, convertedGoalId: null,
    });
  });

  it("round-trips evidence and boolean flags and persists across reopen", () => {
    const opportunity = db.insertOpportunity({
      ...input, evidence: ["Local finding", "reference:notes/idea", 'Quotes " and 한글'],
      estimatedValueCents: 1200, estimatedEffort: "medium", riskLevel: "high",
      confidence: 0.75, requiresExternalAction: true,
    });
    expect(db.getOpportunityById(opportunity.id)).toEqual(opportunity);
    expect(db.raw.prepare("SELECT evidence, requires_external_action FROM opportunities WHERE id = ?").get(opportunity.id))
      .toEqual({ evidence: JSON.stringify(opportunity.evidence), requires_external_action: 1 });
    db.close();
    db = createDatabase(dbPath);
    expect(db.getOpportunityById(opportunity.id)).toEqual(opportunity);
    expect(db.getOpportunityById("missing")).toBeUndefined();
    const defaults = db.insertOpportunity({ ...input, id: undefined });
    expect(defaults.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(db.getOpportunityById(defaults.id)?.requiresExternalAction).toBe(false);
    expect(() => db.insertOpportunity(input)).toThrow();
  });

  it("lists all or by status, newest first with deterministic ties and limits", () => {
    db.insertOpportunity({ ...input, id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    db.insertOpportunity({ ...input, id: "b", createdAt: "2026-01-02T00:00:00.000Z" });
    db.insertOpportunity({ ...input, id: "c", createdAt: "2026-01-02T00:00:00.000Z" });
    db.updateOpportunityReview("b", { status: "shortlisted" });
    expect(db.listOpportunities().map((row) => row.id)).toEqual(["c", "b", "a"]);
    expect(db.listOpportunities({ status: "discovered" }).map((row) => row.id)).toEqual(["c", "a"]);
    expect(db.listOpportunities({ status: "shortlisted", limit: 1 }).map((row) => row.id)).toEqual(["b"]);
    expect(db.listOpportunities({ limit: 1 }).map((row) => row.id)).toEqual(["c"]);
    expect(db.listOpportunities({ limit: 0 })).toEqual([]);
    expect(() => db.listOpportunities({ status: "invalid" as OpportunityStatus })).toThrow();
    expect(() => db.listOpportunities({ limit: -1 })).toThrow();
  });

  it("records shortlist and conversion reviews without creating execution state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
    db.insertOpportunity({ ...input, requiresExternalAction: true });
    const shortlist = db.updateOpportunityReview(input.id!, { status: "shortlisted" });
    expect(shortlist.reviewedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(shortlist.requiresExternalAction).toBe(true);
    expect(shortlist.convertedGoalId).toBeNull();
    vi.setSystemTime(new Date("2026-01-04T00:00:00.000Z"));
    const converted = db.updateOpportunityReview(input.id!, { status: "converted", convertedGoalId: "future-goal" });
    expect(db.getOpportunityById(input.id!)).toEqual(converted);
    expect(converted).toMatchObject({ status: "converted", reviewedAt: "2026-01-04T00:00:00.000Z", convertedGoalId: "future-goal" });
    for (const table of ["goals", "task_graph", "event_stream"]) {
      expect(db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it.each([false, true])("allows rejection with prior shortlist=%s", (shortlist) => {
    db.insertOpportunity(input);
    if (shortlist) db.updateOpportunityReview(input.id!, { status: "shortlisted" });
    const rejected = db.updateOpportunityReview(input.id!, { status: "rejected" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewedAt).toBeTruthy();
    expect(() => db.updateOpportunityReview(input.id!, { status: "shortlisted" })).toThrow();
  });

  it("rejects invalid transitions and goal references without changing the row", () => {
    const opportunity = db.insertOpportunity(input);
    expect(() => db.updateOpportunityReview(input.id!, { status: "converted" })).toThrow();
    expect(() => db.updateOpportunityReview(input.id!, { status: "shortlisted", convertedGoalId: "goal" })).toThrow();
    expect(() => db.updateOpportunityReview(input.id!, { status: "invalid" as "rejected" })).toThrow();
    expect(() => db.updateOpportunityReview("missing", { status: "rejected" })).toThrow();
    expect(db.getOpportunityById(input.id!)).toEqual(opportunity);
    db.updateOpportunityReview(input.id!, { status: "shortlisted" });
    db.updateOpportunityReview(input.id!, { status: "converted" });
    expect(db.getOpportunityById(input.id!)?.convertedGoalId).toBeNull();
    expect(() => db.updateOpportunityReview(input.id!, { status: "rejected" })).toThrow();
  });

  it.each([
    { title: " " }, { confidence: -0.1 }, { confidence: 1.1 },
    { confidence: NaN }, { confidence: Infinity }, { estimatedValueCents: -1 },
    { estimatedValueCents: 1.5 }, { status: "invalid" }, { requiresExternalAction: "false" },
    { evidence: [1] }, { estimatedEffort: "invalid" }, { riskLevel: "invalid" },
  ])("rejects invalid input %j", (invalid) => {
    expect(() => db.insertOpportunity({ ...input, ...invalid } as OpportunityInput)).toThrow();
    expect(db.listOpportunities()).toEqual([]);
  });

  it.each([0, 1])("accepts confidence boundary %s", (confidence) => {
    expect(db.insertOpportunity({ ...input, confidence }).confidence).toBe(confidence);
  });

  it.each(Array.from({ length: 11 }, (_, index) => index + 1))(
    "upgrades a V%s database while preserving existing data",
    (version) => {
      db.close();
      const legacy = new Database(dbPath);
      // Replace the fresh fixture with a genuine schema at the requested version.
      const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      legacy.pragma("foreign_keys = OFF");
      for (const { name } of tables) legacy.exec(`DROP TABLE "${name}"`);
      legacy.exec(schema.CREATE_TABLES);
      const migrations = [
        schema.MIGRATION_V2, schema.MIGRATION_V3,
        schema.MIGRATION_V4 + schema.MIGRATION_V4_ALTER + schema.MIGRATION_V4_ALTER2 +
          schema.MIGRATION_V4_ALTER_INBOX_STATUS + schema.MIGRATION_V4_ALTER_INBOX_RETRY + schema.MIGRATION_V4_ALTER_INBOX_MAX_RETRIES,
        schema.MIGRATION_V5, schema.MIGRATION_V6, schema.MIGRATION_V7, schema.MIGRATION_V8,
        schema.MIGRATION_V9 + schema.MIGRATION_V9_ALTER_CHILDREN_ROLE,
        schema.MIGRATION_V10, schema.MIGRATION_V11,
      ];
      for (let migrationVersion = 2; migrationVersion <= version; migrationVersion++) {
        legacy.exec(migrations[migrationVersion - 2]);
      }
      legacy.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
      legacy.prepare("INSERT INTO kv (key, value) VALUES ('legacy', 'preserved')").run();
      legacy.prepare("INSERT INTO identity (key, value) VALUES ('name', 'raccoon')").run();
      const goalId = version >= 9
        ? insertGoal(legacy, { title: "Existing goal", description: "Preserve" })
        : undefined;
      legacy.close();
      db = createDatabase(dbPath);
      expect(db.getKV("legacy")).toBe("preserved");
      expect(db.getIdentity("name")).toBe("raccoon");
      if (goalId) expect(getGoalById(db.raw, goalId)?.title).toBe("Existing goal");
      db.setKV("new", "value");
      expect(db.getKV("new")).toBe("value");
      db.insertOpportunity(input);
      expect(db.getOpportunityById(input.id!)?.title).toBe(input.title);
      expect(db.raw.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: schema.SCHEMA_VERSION });
      expect(db.raw.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    },
  );
});
