import type Database from "better-sqlite3";

interface CountRow {
  count: number;
}

interface ToolUsageRow {
  name: string;
  count: number;
  failures: number;
}

interface InferenceRow {
  model: string;
  provider: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  cache_hits: number;
}

interface TaskStatusRow {
  status: string;
  count: number;
}

export interface WeeklyReportSummary {
  periodStart: string;
  periodEnd: string;
  turns: number;
  toolCalls: number;
  toolFailures: number;
  tools: ToolUsageRow[];
  inference: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    cacheHits: number;
    models: InferenceRow[];
  };
  codex: {
    calls: number;
    tokensUsed: number;
    cacheHits: number;
  };
  tasks: {
    total: number;
    byStatus: TaskStatusRow[];
  };
  events: number;
  modifications: number;
}

function countSince(
  db: Database.Database,
  table: string,
  column: string,
  since: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ${table}
       WHERE julianday(${column}) >= julianday(?)`,
    )
    .get(since) as CountRow;

  return row.count;
}

function parseCodexTokens(result: string): number {
  const match = result.match(/Tokens used(?: this call)?:\s*([\d,]+)/i);
  if (!match) return 0;

  return Number(match[1].replaceAll(",", ""));
}

export function buildWeeklyReportSummary(
  db: Database.Database,
  now = new Date(),
  days = 7,
): WeeklyReportSummary {
  const periodEnd = now.toISOString();
  const periodStart = new Date(
    now.getTime() - days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const tools = db
    .prepare(
      `SELECT
         name,
         COUNT(*) AS count,
         SUM(
           CASE
             WHEN error IS NOT NULL OR result LIKE 'ERROR:%' THEN 1
             ELSE 0
           END
         ) AS failures
       FROM tool_calls
       WHERE julianday(created_at) >= julianday(?)
       GROUP BY name
       ORDER BY count DESC, name ASC`,
    )
    .all(periodStart) as ToolUsageRow[];

  const models = db
    .prepare(
      `SELECT
         model,
         provider,
         COUNT(*) AS calls,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cost_cents), 0) AS cost_cents,
         COALESCE(SUM(cache_hit), 0) AS cache_hits
       FROM inference_costs
       WHERE julianday(created_at) >= julianday(?)
       GROUP BY model, provider
       ORDER BY calls DESC, model ASC`,
    )
    .all(periodStart) as InferenceRow[];

  const codexResults = db
    .prepare(
      `SELECT result
       FROM tool_calls
       WHERE name = 'codex_task'
         AND julianday(created_at) >= julianday(?)`,
    )
    .all(periodStart) as Array<{ result: string }>;

  const taskStatuses = db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM task_graph
       WHERE julianday(created_at) >= julianday(?)
       GROUP BY status
       ORDER BY count DESC, status ASC`,
    )
    .all(periodStart) as TaskStatusRow[];

  return {
    periodStart,
    periodEnd,
    turns: countSince(db, "turns", "timestamp", periodStart),
    toolCalls: tools.reduce((sum, row) => sum + row.count, 0),
    toolFailures: tools.reduce((sum, row) => sum + row.failures, 0),
    tools,
    inference: {
      calls: models.reduce((sum, row) => sum + row.calls, 0),
      inputTokens: models.reduce((sum, row) => sum + row.input_tokens, 0),
      outputTokens: models.reduce((sum, row) => sum + row.output_tokens, 0),
      costCents: models.reduce((sum, row) => sum + row.cost_cents, 0),
      cacheHits: models.reduce((sum, row) => sum + row.cache_hits, 0),
      models,
    },
    codex: {
      calls: codexResults.length,
      tokensUsed: codexResults.reduce(
        (sum, row) => sum + parseCodexTokens(row.result),
        0,
      ),
      cacheHits: codexResults.filter(
        (row) =>
          /Cached:\s*yes/i.test(row.result) ||
          /result reused from cache/i.test(row.result),
      ).length,
    },
    tasks: {
      total: taskStatuses.reduce((sum, row) => sum + row.count, 0),
      byStatus: taskStatuses,
    },
    events: countSince(db, "event_stream", "created_at", periodStart),
    modifications: countSince(
      db,
      "modifications",
      "timestamp",
      periodStart,
    ),
  };
}

function markdownTableRow(values: Array<string | number>): string {
  return `| ${values.map((value) => String(value).replaceAll("|", "\\|")).join(" | ")} |`;
}

export function renderWeeklyReportMarkdown(
  summary: WeeklyReportSummary,
): string {
  const lines: string[] = [
    "# Raccoon Weekly Report",
    "",
    `Period: ${summary.periodStart} → ${summary.periodEnd}`,
    "",
    "## Activity",
    "",
    `- Turns: ${summary.turns}`,
    `- Tool calls: ${summary.toolCalls}`,
    `- Tool failures: ${summary.toolFailures}`,
    `- Tasks created: ${summary.tasks.total}`,
    `- Events recorded: ${summary.events}`,
    `- Modifications recorded: ${summary.modifications}`,
    "",
    "## Tool Usage",
    "",
    "| Tool | Calls | Failures |",
    "| --- | ---: | ---: |",
  ];

  if (summary.tools.length === 0) {
    lines.push("| _none_ | 0 | 0 |");
  } else {
    for (const tool of summary.tools) {
      lines.push(markdownTableRow([tool.name, tool.count, tool.failures]));
    }
  }

  lines.push(
    "",
    "## Inference",
    "",
    `- Calls: ${summary.inference.calls}`,
    `- Input tokens: ${summary.inference.inputTokens}`,
    `- Output tokens: ${summary.inference.outputTokens}`,
    `- Recorded cost: ${summary.inference.costCents} cents`,
    `- Cache hits: ${summary.inference.cacheHits}`,
    "",
    "| Model | Provider | Calls | Input | Output | Cost (cents) |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  );

  if (summary.inference.models.length === 0) {
    lines.push("| _none_ | - | 0 | 0 | 0 | 0 |");
  } else {
    for (const model of summary.inference.models) {
      lines.push(
        markdownTableRow([
          model.model,
          model.provider,
          model.calls,
          model.input_tokens,
          model.output_tokens,
          model.cost_cents,
        ]),
      );
    }
  }

  lines.push(
    "",
    "## Codex Worker",
    "",
    `- Calls: ${summary.codex.calls}`,
    `- CLI-reported tokens used: ${summary.codex.tokensUsed}`,
    `- Cache hits: ${summary.codex.cacheHits}`,
  );

  if (summary.tasks.byStatus.length > 0) {
    lines.push(
      "",
      "## Task Status",
      "",
      "| Status | Count |",
      "| --- | ---: |",
    );

    for (const task of summary.tasks.byStatus) {
      lines.push(markdownTableRow([task.status, task.count]));
    }
  }

  return `${lines.join("\n")}\n`;
}
