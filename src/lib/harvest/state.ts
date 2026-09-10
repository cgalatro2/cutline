import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathExists, readTextFile, ensureDir } from "../files.js";
import {
  emptyHarvestState,
  type HarvestState,
} from "./types.js";

export function defaultStatePath(homedir = os.homedir()): string {
  return path.join(homedir, ".cutline", "state.json");
}

export function defaultHarvestsDir(homedir = os.homedir()): string {
  return path.join(homedir, ".cutline", "harvests");
}

export async function readHarvestState(
  statePath: string,
): Promise<{ state: HarvestState; existed: boolean }> {
  if (!(await pathExists(statePath))) {
    return { state: emptyHarvestState(), existed: false };
  }

  const raw = await readTextFile(statePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      `Cutline state is not valid JSON: ${statePath}. Fix or delete the file and retry.`,
    );
  }

  return { state: validateHarvestState(parsed, statePath), existed: true };
}

export function validateHarvestState(
  value: unknown,
  statePath: string,
): HarvestState {
  if (!value || typeof value !== "object") {
    throw invalidState(statePath);
  }
  const rec = value as Record<string, unknown>;
  if (rec.version !== 1) {
    throw new Error(
      `Unsupported Cutline state version in ${statePath}. Expected version 1.`,
    );
  }

  const cursor = rec.cursor;
  const chatgpt = rec.chatgpt;
  if (!cursor || typeof cursor !== "object" || !chatgpt || typeof chatgpt !== "object") {
    throw invalidState(statePath);
  }

  const filesRaw = (cursor as Record<string, unknown>).files;
  const convRaw = (chatgpt as Record<string, unknown>).conversations;
  if (!filesRaw || typeof filesRaw !== "object" || !convRaw || typeof convRaw !== "object") {
    throw invalidState(statePath);
  }

  const files: HarvestState["cursor"]["files"] = {};
  for (const [filePath, meta] of Object.entries(filesRaw)) {
    if (!meta || typeof meta !== "object") throw invalidState(statePath);
    const offset = (meta as { offset?: unknown }).offset;
    if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) {
      throw invalidState(statePath);
    }
    files[filePath] = { offset };
  }

  const conversations: HarvestState["chatgpt"]["conversations"] = {};
  for (const [id, meta] of Object.entries(convRaw)) {
    if (!meta || typeof meta !== "object") throw invalidState(statePath);
    const messageIds = (meta as { messageIds?: unknown }).messageIds;
    if (!Array.isArray(messageIds) || messageIds.some((item) => typeof item !== "string")) {
      throw invalidState(statePath);
    }
    conversations[id] = { messageIds: [...new Set(messageIds)] };
  }

  const initializedRaw = (chatgpt as Record<string, unknown>).initialized;
  let initialized: boolean;
  if (initializedRaw === undefined) {
    initialized = true;
  } else if (typeof initializedRaw === "boolean") {
    initialized = initializedRaw;
  } else {
    throw invalidState(statePath);
  }

  const last = rec.lastSuccessfulHarvestAt;
  if (last !== undefined && typeof last !== "string") {
    throw invalidState(statePath);
  }

  return {
    version: 1,
    cursor: { files },
    chatgpt: { conversations, initialized },
    lastSuccessfulHarvestAt: last,
  };
}

export async function writeHarvestState(
  statePath: string,
  state: HarvestState,
): Promise<void> {
  await ensureDir(path.dirname(statePath));
  const tmpPath = `${statePath}.tmp`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(tmpPath, payload, "utf8");
  await rename(tmpPath, statePath);
}

export function checkpointsEqual(a: HarvestState, b: HarvestState): boolean {
  return (
    JSON.stringify(a.cursor) === JSON.stringify(b.cursor) &&
    JSON.stringify(a.chatgpt) === JSON.stringify(b.chatgpt)
  );
}

function invalidState(statePath: string): Error {
  return new Error(
    `Cutline state is invalid: ${statePath}. Fix or delete the file and retry.`,
  );
}
