import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  HarvestCollectOptions,
  HarvestState,
  HarvestedMessage,
} from "./types.js";

export type CursorCollectResult = {
  messages: HarvestedMessage[];
  files: Record<string, { offset: number }>;
};

type ContentPart = {
  type?: string;
  text?: string;
};

type TranscriptRecord = {
  role?: string;
  type?: string;
  message?: { content?: ContentPart[] };
};

const TITLE_MAX = 80;

export function defaultCursorProjectsDir(homedir = os.homedir()): string {
  return path.join(homedir, ".cursor", "projects");
}

export function workspaceFromProjectSlug(slug: string): string {
  const marker = "-projects-";
  const idx = slug.lastIndexOf(marker);
  if (idx !== -1) return slug.slice(idx + marker.length);
  return slug;
}

export function parseCursorTimestamp(raw: string): string | undefined {
  const trimmed = raw.trim();
  const match = trimmed.match(
    /^(?:[A-Za-z]+,\s*)?([A-Za-z]+ \d{1,2}, \d{4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM))\s*\(UTC([+-]\d{1,2})\)$/i,
  );
  if (match) {
    const offsetHours = Number(match[3]);
    const sign = offsetHours >= 0 ? "+" : "-";
    const hh = String(Math.abs(offsetHours)).padStart(2, "0");
    const parsed = Date.parse(`${match[1]} ${match[2]} GMT${sign}${hh}00`);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  const fallback = Date.parse(trimmed);
  if (Number.isNaN(fallback)) return undefined;
  return new Date(fallback).toISOString();
}

export function titleFromQuery(query: string): string {
  const line = query.split(/\n/)[0]?.trim() ?? "";
  if (line.length <= TITLE_MAX) return line;
  return `${line.slice(0, TITLE_MAX - 3)}...`;
}

export async function collectCursor(options: {
  projectsDir: string;
  state: HarvestState;
  collect: HarvestCollectOptions;
}): Promise<CursorCollectResult> {
  const files: Record<string, { offset: number }> = { ...options.state.cursor.files };
  const messages: HarvestedMessage[] = [];
  const paths = await discoverParentTranscripts(options.projectsDir);

  for (const filePath of paths) {
    const result = await readTranscriptFile(
      filePath,
      options.state.cursor.files[filePath]?.offset,
      options.collect,
    );
    const shouldUpdate =
      options.collect.sealAll ||
      options.collect.sinceMs === undefined ||
      result.harvestedCount > 0;
    if (shouldUpdate) {
      files[filePath] = { offset: result.offset };
    }
    messages.push(...result.messages);
  }

  return { messages, files };
}

export async function discoverParentTranscripts(
  projectsDir: string,
): Promise<string[]> {
  const found: string[] = [];
  await walkDir(projectsDir, found);
  found.sort();
  return found;
}

async function walkDir(dir: string, found: string[]): Promise<void> {
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
      if (entry.name === "subagents") continue;
      await walkDir(full, found);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    if (full.includes(`${path.sep}subagents${path.sep}`)) continue;
    if (!full.includes(`${path.sep}agent-transcripts${path.sep}`)) continue;
    found.push(full);
  }
}

async function readTranscriptFile(
  filePath: string,
  storedOffset: number | undefined,
  collect: HarvestCollectOptions,
): Promise<{
  messages: HarvestedMessage[];
  offset: number;
  harvestedCount: number;
}> {
  const info = await stat(filePath);
  let offset = storedOffset ?? 0;
  if (info.size < offset) offset = 0;

  const startOffset = offset;
  let chunk = "";
  if (info.size > startOffset) {
    const handle = await open(filePath, "r");
    try {
      const length = info.size - startOffset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, startOffset);
      chunk = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  const { lines, newOffset } = splitCompleteLines(chunk, startOffset);
    const parsed = collect.includeMessages
      ? parseTranscriptLines(lines, filePath, info.mtimeMs, collect)
      : [];
  return {
    messages: parsed,
    offset: newOffset,
    harvestedCount: parsed.length,
  };
}

export function splitCompleteLines(
  chunk: string,
  startOffset: number,
): { lines: string[]; newOffset: number } {
  const lines: string[] = [];
  let consumed = 0;
  while (consumed < chunk.length) {
    const idx = chunk.indexOf("\n", consumed);
    if (idx === -1) break;
    const line = chunk.slice(consumed, idx).replace(/\r$/, "");
    if (line.length > 0) lines.push(line);
    consumed = idx + 1;
  }
  const consumedBytes = Buffer.byteLength(chunk.slice(0, consumed), "utf8");
  return { lines, newOffset: startOffset + consumedBytes };
}

export function parseTranscriptLines(
  lines: string[],
  filePath: string,
  fileMtimeMs: number,
  collect: HarvestCollectOptions,
): HarvestedMessage[] {
  const conversationId = conversationIdFromPath(filePath);
  const workspace = workspaceFromPath(filePath);
  const pending: Array<HarvestedMessage & { timeMs?: number }> = [];
  let lastUserTimeMs: number | undefined;
  let lastUserIso: string | undefined;

  for (const line of lines) {
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (record.type === "turn_ended") continue;
    if (record.role !== "user" && record.role !== "assistant") continue;

    const parts = record.message?.content ?? [];
    if (record.role === "user") {
      const blob = textFromParts(parts);
      if (!blob) continue;
      const extracted = extractUserQuery(blob);
      if (!extracted.query) continue;
      const iso = extracted.timestamp
        ? parseCursorTimestamp(extracted.timestamp)
        : undefined;
      const timeMs = iso ? Date.parse(iso) : undefined;
      if (timeMs !== undefined) {
        lastUserTimeMs = timeMs;
        lastUserIso = iso;
      }
      pending.push({
        source: "cursor",
        conversationId,
        conversationTitle: undefined,
        workspace,
        timestamp: iso,
        role: "user",
        content: extracted.query,
        timeMs,
      });
      continue;
    }

    const text = textFromParts(parts);
    if (!text) continue;
    pending.push({
      source: "cursor",
      conversationId,
      conversationTitle: undefined,
      workspace,
      timestamp: lastUserIso,
      role: "assistant",
      content: text,
      timeMs: lastUserTimeMs,
    });
  }

  const title = titleFromQuery(
    pending.find((m) => m.role === "user")?.content ?? conversationId,
  );
  const lastActivityMs = Math.max(
    fileMtimeMs,
    ...pending.map((m) => m.timeMs).filter((n): n is number => n !== undefined),
  );
  const conversationInWindow =
    collect.sinceMs === undefined || lastActivityMs >= collect.sinceMs;
  if (!conversationInWindow) return [];

  const harvested: HarvestedMessage[] = [];
  for (const item of pending) {
    const inWindow =
      collect.sinceMs === undefined ||
      (item.timeMs !== undefined
        ? item.timeMs >= collect.sinceMs
        : conversationInWindow);
    if (!inWindow) continue;
    harvested.push({
      source: item.source,
      conversationId: item.conversationId,
      conversationTitle: title,
      workspace: item.workspace,
      timestamp: item.timestamp,
      role: item.role,
      content: item.content,
    });
  }
  return harvested;
}

function conversationIdFromPath(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

function workspaceFromPath(filePath: string): string | undefined {
  const projectsIdx = filePath.lastIndexOf(`${path.sep}projects${path.sep}`);
  if (projectsIdx === -1) return undefined;
  const rest = filePath.slice(projectsIdx + `${path.sep}projects${path.sep}`.length);
  const slug = rest.split(path.sep)[0];
  if (!slug) return undefined;
  return workspaceFromProjectSlug(slug);
}

function textFromParts(parts: ContentPart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n\n");
}

function extractUserQuery(blob: string): { query: string; timestamp?: string } {
  const ts = blob.match(/<timestamp>([\s\S]*?)<\/timestamp>/);
  const query = blob.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (!query) return { query: "" };
  return {
    query: query[1].trim(),
    timestamp: ts?.[1]?.trim(),
  };
}
