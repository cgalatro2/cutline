import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../files.js";
import type {
  HarvestCollectOptions,
  HarvestState,
  HarvestedMessage,
} from "./types.js";

export const CHATGPT_SETUP_MESSAGE = `chatdump is not installed or not on PATH.

Install it from https://github.com/combinatrix-ai/chatdump, add a ChatGPT account in the menu bar, then install the CLI from the chatdump menu (Install Command Line Tool).

If the app is already installed, Cutline also looks for:
/Applications/chatdump.app/Contents/MacOS/chatdump`;

export type ChatgptDeps = {
  runChatdump?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  cacheDirs?: string[];
  skipSync?: boolean;
};

export type ChatgptCollectResult = {
  messages: HarvestedMessage[];
  conversations: Record<string, { messageIds: string[] }>;
};

export function isChatdumpMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes("not installed");
}

type MappingNode = {
  id?: string;
  parent?: string | null;
  message?: {
    id?: string;
    author?: { role?: string };
    create_time?: number | null;
    content?: { parts?: unknown[] };
  };
};

type ConversationFile = {
  id?: string;
  conversation_id?: string;
  title?: string;
  update_time?: number;
  current_node?: string;
  mapping?: Record<string, MappingNode>;
};

const CHATGPT_BINARIES = [
  "chatdump",
  "/Applications/chatdump.app/Contents/MacOS/chatdump",
];

export async function collectChatgpt(options: {
  homedir: string;
  state: HarvestState;
  collect: HarvestCollectOptions;
  deps?: ChatgptDeps;
}): Promise<ChatgptCollectResult> {
  const run = options.deps?.runChatdump ?? runChatdump;
  if (!options.deps?.skipSync) {
    try {
      await run(["sync", "--provider", "openai"]);
    } catch (error) {
      throw wrapChatdumpError(error);
    }
  }

  const cacheDirs =
    options.deps?.cacheDirs ??
    (await discoverCacheDirs(options.homedir, run));

  const conversations: Record<string, { messageIds: string[] }> = {
    ...cloneConversations(options.state.chatgpt.conversations),
  };
  const messages: HarvestedMessage[] = [];

  for (const dir of cacheDirs) {
    const files = await listJsonFiles(dir);
    for (const filePath of files) {
      const raw = await readFile(filePath, "utf8");
      let parsed: ConversationFile;
      try {
        parsed = JSON.parse(raw) as ConversationFile;
      } catch {
        continue;
      }
      const result = harvestConversation(parsed, options.state, options.collect);
      if (!result) continue;
      messages.push(...result.messages);
      const shouldUpdate =
        options.collect.sealAll || result.harvestedIds.length > 0;
      if (shouldUpdate) {
        const prev = conversations[result.conversationId]?.messageIds ?? [];
        const ids = options.collect.sealAll
          ? result.allIds
          : uniqueStrings([...prev, ...result.harvestedIds]);
        conversations[result.conversationId] = { messageIds: ids };
      }
    }
  }

  return { messages, conversations };
}

export function harvestConversation(
  parsed: ConversationFile,
  state: HarvestState,
  collect: HarvestCollectOptions,
): {
  conversationId: string;
  messages: HarvestedMessage[];
  harvestedIds: string[];
  allIds: string[];
} | null {
  const conversationId = parsed.conversation_id || parsed.id;
  if (!conversationId || !parsed.mapping) return null;

  const linearized = linearizeConversation(parsed);
  const allIds = linearized.map((item) => item.id);
  const seen = new Set(
    state.chatgpt.conversations[conversationId]?.messageIds ?? [],
  );
  const title = parsed.title?.trim() || conversationId;

  const times = linearized
    .map((item) => item.timeMs)
    .filter((n): n is number => n !== undefined);
  if (typeof parsed.update_time === "number") {
    times.push(parsed.update_time * 1000);
  }
  const lastActivityMs = times.length > 0 ? Math.max(...times) : undefined;
  const conversationInWindow =
    collect.sinceMs === undefined ||
    (lastActivityMs !== undefined && lastActivityMs >= collect.sinceMs);

  const messages: HarvestedMessage[] = [];
  const harvestedIds: string[] = [];

  if (collect.includeMessages && conversationInWindow) {
    for (const item of linearized) {
      if (seen.has(item.id)) continue;
      const inWindow =
        collect.sinceMs === undefined ||
        (item.timeMs !== undefined
          ? item.timeMs >= collect.sinceMs
          : true);
      if (!inWindow) continue;
      messages.push({
        source: "chatgpt",
        conversationId,
        messageId: item.id,
        conversationTitle: title,
        timestamp: item.timestamp,
        role: item.role,
        content: item.content,
      });
      harvestedIds.push(item.id);
    }
  }

  return { conversationId, messages, harvestedIds, allIds };
}

export function linearizeConversation(parsed: ConversationFile): Array<{
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  timeMs?: number;
}> {
  const mapping = parsed.mapping ?? {};
  const order: string[] = [];
  const visited = new Set<string>();
  let nodeId: string | undefined = parsed.current_node;
  while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
    visited.add(nodeId);
    order.push(nodeId);
    nodeId = mapping[nodeId].parent ?? undefined;
  }
  order.reverse();

  const out: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp?: string;
    timeMs?: number;
  }> = [];

  for (const id of order) {
    const node = mapping[id];
    const message = node?.message;
    if (!message) continue;
    const role = message.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = partsToText(message.content?.parts);
    if (!content) continue;
    const messageId = message.id || node.id || id;
    const timeMs =
      typeof message.create_time === "number"
        ? message.create_time * 1000
        : undefined;
    out.push({
      id: messageId,
      role,
      content,
      timestamp:
        timeMs !== undefined ? new Date(timeMs).toISOString() : undefined,
      timeMs,
    });
  }

  return out;
}

async function discoverCacheDirs(
  homedir: string,
  run: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<string[]> {
  const dirs = new Set<string>();
  dirs.add(path.join(homedir, "chatdump", ".chatdump", "cache", "chatgpt"));

  try {
    const { stdout } = await run(["list", "--json"]);
    const parsed: unknown = JSON.parse(stdout);
    collectVaultPaths(parsed, dirs);
  } catch {
    // Default vault is enough when list is unavailable.
  }

  const existing: string[] = [];
  for (const dir of dirs) {
    if (await pathExists(dir)) existing.push(dir);
  }
  return existing;
}

function collectVaultPaths(value: unknown, dirs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectVaultPaths(item, dirs);
    return;
  }
  if (!value || typeof value !== "object") return;
  const rec = value as Record<string, unknown>;
  for (const key of ["vaultPath", "vault", "vaultDir", "path"]) {
    if (typeof rec[key] === "string") {
      dirs.add(path.join(rec[key], ".chatdump", "cache", "chatgpt"));
    }
  }
  for (const nested of Object.values(rec)) collectVaultPaths(nested, dirs);
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  await walkJson(dir, found);
  return found.sort();
}

async function walkJson(dir: string, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJson(full, found);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      found.push(full);
    }
  }
}

function partsToText(parts: unknown[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function cloneConversations(
  value: Record<string, { messageIds: string[] }>,
): Record<string, { messageIds: string[] }> {
  const out: Record<string, { messageIds: string[] }> = {};
  for (const [id, meta] of Object.entries(value)) {
    out[id] = { messageIds: [...meta.messageIds] };
  }
  return out;
}

function uniqueStrings(ids: string[]): string[] {
  return [...new Set(ids)];
}

function wrapChatdumpError(error: unknown): Error {
  if (error instanceof Error && error.message.includes("not installed")) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `chatdump sync failed. Re-login from the chatdump menu bar app and retry.\n${detail}`,
  );
}

async function runChatdump(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  let lastError: unknown;
  for (const binary of CHATGPT_BINARIES) {
    try {
      return await spawnCommand(binary, args);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT" || (error instanceof Error && error.message.includes("not installed"))) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error
    ? new Error(CHATGPT_SETUP_MESSAGE)
    : new Error(CHATGPT_SETUP_MESSAGE);
}

function spawnCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(CHATGPT_SETUP_MESSAGE));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `chatdump exited with code ${code ?? "unknown"}.\n${stderr.trim()}`,
        ),
      );
    });
  });
}
