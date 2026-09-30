import Database from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildWeeklyReportSummary,
  renderWeeklyReportMarkdown,
} from "./weekly-report.js";

async function main(): Promise<void> {
  const dbPath = path.join(os.homedir(), ".automaton", "state.db");
  const db = new Database(dbPath, { readonly: true });

  try {
    const summary = buildWeeklyReportSummary(db);
    const markdown = renderWeeklyReportMarkdown(summary);

    const reportDir = path.resolve("reports", "weekly");
    await mkdir(reportDir, { recursive: true });

    const date = summary.periodEnd.slice(0, 10);
    const reportPath = path.join(reportDir, `${date}.md`);

    await writeFile(reportPath, markdown, "utf8");

    console.log(`Weekly report written: ${reportPath}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
