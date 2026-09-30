import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CodexTaskInput {
  task: string;
  files: string[];
  successCriteria: string;
}

export interface CodexTaskResult {
  response: string;
  tokensUsed?: number;
  cached?: boolean;
}

const codexTaskCache = new Map<string, CodexTaskResult>();

function validateFiles(files: string[]): string[] {
  if (files.length === 0 || files.length > 3) {
    throw new Error("codex_task requires 1-3 files");
  }

  return files.map((file) => {
    const normalized = path.normalize(file);

    if (
      path.isAbsolute(normalized) ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith(`..${path.sep}`)
    ) {
      throw new Error(`Invalid file path: ${file}`);
    }

    return normalized;
  });
}

function runCodex(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const settleResolve = (value: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;

      // Ask Codex to stop first. Do not reject yet: wait until the process
      // actually closes so the caller cannot clean up resources too early.
      child.kill("SIGTERM");

      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5_000);
    }, 120_000);

    child.on("error", (error) => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      settleReject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);

      if (timedOut) {
        settleReject(new Error("Codex task timed out after 120 seconds"));
        return;
      }

      if (code !== 0) {
        settleReject(
          new Error(
            `Codex exited with code ${code}${signal ? ` (signal: ${signal})` : ""}\n${stderr || stdout}`,
          ),
        );
        return;
      }

      settleResolve({ stdout, stderr });
    });
  });
}

export async function runCodexReadOnlyTask(
  input: CodexTaskInput,
  repoRoot = process.cwd(),
): Promise<CodexTaskResult> {
  const task = input.task.trim();
  const successCriteria = input.successCriteria.trim();
  const files = validateFiles(input.files);

  if (!task || task.length > 2000) {
    throw new Error("task must contain 1-2000 characters");
  }

  if (!successCriteria || successCriteria.length > 1000) {
    throw new Error("successCriteria must contain 1-1000 characters");
  }

  // Cache identical successful tasks while the referenced files are unchanged.
  // This prevents repeated Codex calls from wasting usage.
  const fileFingerprint = createHash("sha256");

  for (const file of files) {
    const absolutePath = path.resolve(repoRoot, file);
    const content = await readFile(absolutePath);

    fileFingerprint.update(file);
    fileFingerprint.update("\0");
    fileFingerprint.update(content);
    fileFingerprint.update("\0");
  }

  const cacheKey = JSON.stringify({
    task,
    files,
    successCriteria,
    fileHash: fileFingerprint.digest("hex"),
  });

  const cachedResult = codexTaskCache.get(cacheKey);
  if (cachedResult) {
    return {
      ...cachedResult,
      tokensUsed: 0,
      cached: true,
    };
  }

  const prompt = [
    "You are a bounded read-only coding worker.",
    "Do not modify, create, delete, install, or commit anything.",
    "Focus on the explicitly listed files.",
    "Do not inspect unrelated files unless strictly necessary.",
    "",
    `Task: ${task}`,
    "",
    "Files:",
    ...files.map((file) => `- ${file}`),
    "",
    `Success criteria: ${successCriteria}`,
    "",
    "Return a concise final answer only.",
  ].join("\n");

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "raccoon-codex-"));
  const outputFile = path.join(tempDir, "last-message.txt");

  try {
    const { stdout, stderr } = await runCodex(
      [
        "exec",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "-C",
        repoRoot,
        "-o",
        outputFile,
        prompt,
      ],
      repoRoot,
    );

    const response = (await readFile(outputFile, "utf8")).trim();

    const diagnosticOutput = `${stdout}\n${stderr}`;
    const tokenMatch = diagnosticOutput.match(
      /tokens used\s*[\r\n]+\s*([\d,]+)/i,
    );

    const result: CodexTaskResult = {
      response,
      tokensUsed: tokenMatch
        ? Number(tokenMatch[1].replaceAll(",", ""))
        : undefined,
      cached: false,
    };

    codexTaskCache.set(cacheKey, result);
    return result;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
