/**
 * Local model discovery.
 *
 * Supports:
 *   1. Ollama     -> /api/tags
 *   2. LM Studio -> /v1/models (OpenAI-compatible fallback)
 */

import type BetterSqlite3 from "better-sqlite3";
import {
  modelRegistryUpsert,
  modelRegistryGet,
} from "../state/database.js";
import type { ModelRegistryRow } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("ollama");

interface OllamaModel {
  name?: string;
  model?: string;
}

interface OllamaTagsResponse {
  models?: OllamaModel[];
}

interface OpenAIModelsResponse {
  data?: Array<{
    id?: string;
  }>;
}

export async function discoverOllamaModels(
  baseUrl: string,
  db: BetterSqlite3.Database,
): Promise<string[]> {
  const root = baseUrl.replace(/\/$/, "");
  let modelIds: string[] = [];

  // 1. Native Ollama discovery
  try {
    const resp = await fetch(`${root}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (resp.ok) {
      const data = (await resp.json()) as OllamaTagsResponse;

      if (Array.isArray(data.models)) {
        modelIds = data.models
          .map((m) => m.name || m.model || "")
          .filter(Boolean);
      }
    }
  } catch {
    // Fall through to OpenAI-compatible discovery.
  }

  // 2. LM Studio / generic OpenAI-compatible server
  if (modelIds.length === 0) {
    try {
      const resp = await fetch(`${root}/v1/models`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (resp.ok) {
        const data = (await resp.json()) as OpenAIModelsResponse;

        if (Array.isArray(data.data)) {
          modelIds = data.data
            .map((m) => m.id || "")
            .filter(Boolean);
        }
      }
    } catch (err: any) {
      logger.warn(
        `Local inference server not reachable at ${baseUrl}: ${err.message}`,
      );
      return [];
    }
  }

  if (modelIds.length === 0) {
    logger.warn(`No local models discovered at ${baseUrl}`);
    return [];
  }

  const now = new Date().toISOString();
  const registered: string[] = [];

  for (const modelId of modelIds) {
    const existing = modelRegistryGet(db, modelId);

    const row: ModelRegistryRow = {
      modelId,
      // Keep provider="ollama" because Automaton already routes this
      // provider through a local OpenAI-compatible endpoint.
      provider: "ollama",
      displayName: formatDisplayName(modelId),
      tierMinimum: existing?.tierMinimum ?? "critical",
      costPer1kInput: 0,
      costPer1kOutput: 0,
      maxTokens: existing?.maxTokens ?? 4096,
      contextWindow: existing?.contextWindow ?? 8192,
      supportsTools: existing?.supportsTools ?? true,
      supportsVision: existing?.supportsVision ?? false,
      parameterStyle: "max_tokens",
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    modelRegistryUpsert(db, row);
    registered.push(modelId);
  }

  logger.info(
    `Local inference: registered ${registered.length} model(s): ${registered.join(", ")}`,
  );

  return registered;
}

function formatDisplayName(modelId: string): string {
  return modelId
    .replace(/\//g, " / ")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
