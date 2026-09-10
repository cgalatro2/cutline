import OpenAI from "openai";
import { createOpenAIClient } from "../openai.js";
import type { HarvestedMessage } from "./types.js";

const IDEA_MODEL = "gpt-4o-mini";
export const WINDOW_CHAR_BUDGET = 8_000;
const USER_WINDOW_CAP = 2_000;
const ASSISTANT_WINDOW_CAP = 800;
const NEARBY_ASSISTANT_CAP = 500;
const NEARBY_USER_CAP = 700;
const NEARBY_TOTAL_CAP = 800;
const QUOTE_CHAR_CAP = 280;
const MAX_QUOTES_PER_CLUSTER = 2;
const MAX_MOMENTS_PER_CONVERSATION = 1;
const LABEL_CHAR_CAP = 500;
const MOMENT_TAGS = [
  "decision",
  "surprise",
  "failure",
  "number",
  "reversal",
  "opinion",
] as const;

type MomentTag = (typeof MOMENT_TAGS)[number];

const TAG_RANK: Record<MomentTag, number> = {
  reversal: 0,
  surprise: 1,
  failure: 2,
  number: 3,
  opinion: 4,
  decision: 5,
};

type JsonSchema = Record<string, unknown>;

type MomentDraft = {
  clusterKey: string;
  tag: string;
  quote: string;
  conversationId: string;
};

type FoundMoment = {
  clusterKey: string;
  tag: MomentTag;
  quote: string;
  conversationId: string;
};

type MomentCluster = {
  clusterKey: string;
  tag: MomentTag;
  quotes: string[];
  conversationId: string;
};

type JsonCompletion = (
  system: string,
  user: string,
  schemaName: string,
  schema: JsonSchema,
) => Promise<unknown>;

export type ConversationWindow = {
  text: string;
  conversationId: string;
};

const MOMENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["moments"],
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["clusterKey", "tag", "quote", "conversationId"],
        properties: {
          clusterKey: { type: "string" },
          tag: { type: "string", enum: [...MOMENT_TAGS] },
          quote: { type: "string" },
          conversationId: { type: "string" },
        },
      },
    },
  },
};

const MOMENT_PROMPT = `You are a highlighter, not an editor.

Find moments a builder who does not work on this product would stop scrolling for: a reversal, failed approach, surprising number, hard decision, or sharp opinion.

If there is no such moment, return an empty list. Empty is the common case. Prefer 0. At most 2 moments in one window, and only if they are different incidents.

Skip ticket hygiene, merge conflicts, comment cleanup, CSS and tour tweaks, schema checks, implementation plans, and "I'll go edit the file" talk. Skip personal errands unless the beat is independently sharp.

Do not write a thesis, insight, tweet, or summary. Copy the most specific direct quote, usually the user's surprise or the assistant's reversal, not the plan to change code. Use a short stable clusterKey for the same underlying incident. tag must be one of: decision, surprise, failure, number, reversal, opinion. Use number only for a surprising statistic, not ticket IDs or versions.

conversationId must copy a conversation: value from the supplied references. Never invent IDs or quotes.`;

export async function analyzeHarvest(
  messages: HarvestedMessage[],
  options: {
    label?: string;
    client?: OpenAI;
    completeJson?: JsonCompletion;
  } = {},
): Promise<{ momentsMd: string; momentCount: number }> {
  const client = options.client ?? (options.completeJson ? undefined : createOpenAIClient());
  const completeJson =
    options.completeJson ??
    ((system, user, schemaName, schema) =>
      completeJsonWithOpenAI(client!, system, user, schemaName, schema));
  const windows = momentWindows(messages, options.label);
  const found: FoundMoment[] = [];

  for (const window of windows) {
    const result = await requestJson<{ moments: MomentDraft[] }>(
      completeJson,
      MOMENT_PROMPT,
      window.text,
      "harvest_moments",
      MOMENT_SCHEMA,
      (value) => validateMomentBatch(value, window.conversationId),
    );
    found.push(
      ...keepGroundedMoments(result.moments, messages, window.conversationId),
    );
  }

  const clusters = clusterMoments(found);
  if (clusters.length === 0) {
    return { momentsMd: renderBrief([], messages, options.label), momentCount: 0 };
  }
  return {
    momentsMd: renderBrief(clusters, messages, options.label),
    momentCount: clusters.length,
  };
}

export function stripNoise(messages: HarvestedMessage[]): HarvestedMessage[] {
  return messages.filter((message) => !isNoise(message));
}

export function momentWindows(
  messages: HarvestedMessage[],
  label?: string,
): ConversationWindow[] {
  const prefix = label ? `Context: ${capText(label.trim(), LABEL_CHAR_CAP)}\n\n` : "";
  const pieceLimit = Math.max(1, WINDOW_CHAR_BUDGET - prefix.length - 1);
  const windows: ConversationWindow[] = [];

  for (const group of groupByConversation(stripNoise(messages))) {
    if (!group.messages.some((message) => message.role === "user")) continue;
    let current = prefix;
    for (const formatted of group.messages.map((message) => formatWindowMessage(message))) {
      for (const piece of splitByLength(formatted, pieceLimit)) {
        if (
          current.length > prefix.length &&
          current.length + piece.length + 1 > WINDOW_CHAR_BUDGET
        ) {
          windows.push({
            text: current.trimEnd(),
            conversationId: group.conversationId,
          });
          current = prefix;
        }
        current += `${piece}\n`;
      }
    }
    if (current.trim()) {
      windows.push({
        text: current.trimEnd(),
        conversationId: group.conversationId,
      });
    }
  }
  return windows;
}

export function resequenceMoments(md: string): string {
  let n = 0;
  return md.replace(/^## Moment \d+/gm, () => {
    n += 1;
    return `## Moment ${n}`;
  });
}

export function countMoments(md: string): number {
  return (md.match(/^## Moment /gm) ?? []).length;
}

function isNoise(message: HarvestedMessage): boolean {
  const text = message.content.trim();
  if (!text) return true;
  if (message.role === "user") return isNoiseUser(text);
  return isNoiseAssistant(text);
}

function isNoiseUser(text: string): boolean {
  return (
    text.length <= 12 &&
    /^(ok|okay|go|yes|lgtm|thanks|ty|continue|yep|sure)\.?$/i.test(text)
  );
}

function isNoiseAssistant(text: string): boolean {
  if (/^(done|on it|ok|okay|noted|got it|will do|sure|thanks|sounds good)[.!]?$/i.test(text)) {
    return true;
  }
  if (codeRatio(text) >= 0.5) return true;
  if (hasSpecificSignal(text)) return false;
  return true;
}

function hasSpecificSignal(text: string): boolean {
  return /\b(instead|actually|wrong|don't|fail(?:s|ed|ure)?|should have|we were|the bug|the issue|rather than|the simpler|leftover|the mistake)\b/i.test(
    text,
  );
}

function codeRatio(text: string): number {
  if (!text) return 0;
  let code = 0;
  let inFence = false;
  let last = 0;
  const fence = /```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    if (inFence) code += match.index + 3 - last;
    last = match.index;
    inFence = !inFence;
  }
  if (inFence) code += text.length - last;
  return code / text.length;
}

async function completeJsonWithOpenAI(
  client: OpenAI,
  system: string,
  user: string,
  schemaName: string,
  schema: JsonSchema,
): Promise<unknown> {
  const response = await client.chat.completions.create({
    model: IDEA_MODEL,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        strict: true,
        schema,
      },
    },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const text = response.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenAI returned an empty harvest moments result.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("OpenAI returned invalid JSON for harvest moments.");
  }
}

async function requestJson<T>(
  completeJson: JsonCompletion,
  system: string,
  user: string,
  schemaName: string,
  schema: JsonSchema,
  validate: (value: unknown) => string | undefined,
): Promise<T> {
  let problem: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retrySystem = problem
      ? `${system}\n\nYour previous response was invalid: ${problem}. Return a corrected response.`
      : system;
    const value = await completeJson(retrySystem, user, schemaName, schema);
    problem = validate(value);
    if (!problem) return value as T;
  }
  throw new Error(`OpenAI returned an invalid ${schemaName} response: ${problem}`);
}

function validateMomentBatch(
  value: unknown,
  conversationId: string,
): string | undefined {
  const moments = arrayProperty(value, "moments");
  if (!moments) return "moments must be an array";
  for (const moment of moments) {
    const problem = validateStrings(moment, ["clusterKey", "tag", "quote", "conversationId"]);
    if (problem) return `moment ${problem}`;
    if (!isRecord(moment)) return "moment must be an object";
    if (!MOMENT_TAGS.includes(moment.tag as MomentTag)) {
      return "moment tag must be a known tag";
    }
    if (stringProperty(moment, "conversationId") !== conversationId) {
      return "moment conversationId must match the supplied conversation";
    }
  }
  return undefined;
}

function keepGroundedMoments(
  drafts: MomentDraft[],
  messages: HarvestedMessage[],
  conversationId: string,
): FoundMoment[] {
  const inConversation = messages.filter((message) => message.conversationId === conversationId);
  const kept: FoundMoment[] = [];
  for (const draft of drafts) {
    if (!MOMENT_TAGS.includes(draft.tag as MomentTag)) continue;
    const quote = draft.quote.trim();
    const key = normalizeKey(draft.clusterKey);
    if (!quote || !key || key.length < 4 || !/[a-z]/.test(key)) continue;
    if (isPlanQuote(quote) || isHygieneQuote(quote)) continue;
    const source = inConversation.find((message) => containsQuote(message.content, quote));
    if (!source) continue;
    if (isOffTopicThread(source)) continue;
    if (source.role === "assistant" && !hasSpecificSignal(quote)) continue;
    kept.push({
      clusterKey: key,
      tag: draft.tag as MomentTag,
      quote,
      conversationId,
    });
  }
  return kept;
}

function clusterMoments(moments: FoundMoment[]): MomentCluster[] {
  const groups = new Map<string, FoundMoment[]>();
  const order: string[] = [];
  for (const moment of moments) {
    const groupKey = `${moment.conversationId}:${moment.clusterKey}`;
    if (!groups.has(groupKey)) {
      order.push(groupKey);
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(moment);
  }
  const clustered = order.map((groupKey) => {
    const group = groups.get(groupKey)!;
    const tagCounts = new Map<MomentTag, number>();
    for (const moment of group) {
      tagCounts.set(moment.tag, (tagCounts.get(moment.tag) ?? 0) + 1);
    }
    const tag = [...tagCounts].sort((a, b) => b[1] - a[1])[0]![0];
    return {
      clusterKey: group[0]!.clusterKey,
      tag,
      quotes: uniqueStrings(group.map((moment) => moment.quote)).slice(
        0,
        MAX_QUOTES_PER_CLUSTER,
      ),
      conversationId: group[0]!.conversationId,
    };
  });

  const chosen = new Set<string>();
  const byConversation = new Map<string, MomentCluster[]>();
  for (const cluster of clustered) {
    const list = byConversation.get(cluster.conversationId) ?? [];
    list.push(cluster);
    byConversation.set(cluster.conversationId, list);
  }
  for (const list of byConversation.values()) {
    list.sort((a, b) => TAG_RANK[a.tag] - TAG_RANK[b.tag]);
    for (const cluster of list.slice(0, MAX_MOMENTS_PER_CONVERSATION)) {
      chosen.add(`${cluster.conversationId}:${cluster.clusterKey}`);
    }
  }
  return clustered.filter((cluster) =>
    chosen.has(`${cluster.conversationId}:${cluster.clusterKey}`),
  );
}

function renderBrief(
  clusters: MomentCluster[],
  messages: HarvestedMessage[],
  label?: string,
): string {
  const conversations = new Set(messages.map((message) => message.conversationId));
  const lines = [
    "# Harvest brief",
    "",
    `${messages.length} messages across ${conversations.size} conversations. Full threads: conversations.md.`,
    "",
    "Paste this into a strong editor. Keep moments that are actually a post. Drop the rest. Do not genericize.",
  ];
  if (label?.trim()) {
    lines.push("", `Context: ${label.trim()}`);
  }
  if (clusters.length === 0) {
    lines.push("", "No moments.");
    return `${lines.join("\n")}\n`;
  }

  for (const [index, cluster] of clusters.entries()) {
    const sample = messages.find((message) => message.conversationId === cluster.conversationId);
    const quotes = cluster.quotes
      .map((quote) => `> ${capText(quote, QUOTE_CHAR_CAP).replace(/\n/g, "\n> ")}`)
      .join("\n\n");
    const nearby = nearbyTurns(messages, cluster.conversationId, cluster.quotes);
    lines.push(
      "",
      `## Moment ${index + 1}: ${cluster.clusterKey}`,
      "",
      `- Tag: ${cluster.tag}`,
      `- When: ${formatWhen(sample?.timestamp)}`,
      `- Where: ${conversationLabel(sample)}`,
      `- Archive: conversations.md → ${conversationLabel(sample)}`,
      "",
      "### Quote",
      quotes,
    );
    if (nearby) {
      lines.push("", "### Nearby", nearby);
    }
  }
  return `${lines.join("\n")}\n`;
}

function nearbyTurns(
  messages: HarvestedMessage[],
  conversationId: string,
  quotes: string[],
): string {
  const thread = messages.filter((message) => message.conversationId === conversationId);
  const hit = thread.findIndex((message) =>
    quotes.some((quote) => containsQuote(message.content, quote)),
  );
  if (hit === -1) return "";
  const start = Math.max(0, hit - 1);
  const end = Math.min(thread.length, hit + 2);
  const hitMessage = thread[hit]!;
  const chosen = thread.slice(start, end).filter(
    (message) => message === hitMessage || !isNoise(message),
  );
  const window = chosen.length > 0 ? chosen : [hitMessage];
  const formatted = window
    .map((message) => {
      const who = message.role === "user" ? "User" : "Assistant";
      const cap = message.role === "assistant" ? NEARBY_ASSISTANT_CAP : NEARBY_USER_CAP;
      return `**${who}**\n\n${capText(message.content, cap)}`;
    })
    .join("\n\n");
  return capText(formatted, NEARBY_TOTAL_CAP);
}

function formatWindowMessage(message: HarvestedMessage): string {
  const who = message.role === "user" ? "User" : "Assistant";
  const cap = message.role === "assistant" ? ASSISTANT_WINDOW_CAP : USER_WINDOW_CAP;
  const reference = [
    `conversation: ${message.conversationId}`,
    message.messageId ? `message: ${message.messageId}` : "",
    message.timestamp ? `time: ${message.timestamp}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `**${who}** (${reference})\n\n${capText(message.content, cap)}\n`;
}

function groupByConversation(
  messages: HarvestedMessage[],
): Array<{ conversationId: string; messages: HarvestedMessage[] }> {
  const order: string[] = [];
  const map = new Map<string, HarvestedMessage[]>();
  for (const message of messages) {
    const key = `${message.source}:${message.conversationId}`;
    if (!map.has(key)) {
      order.push(key);
      map.set(key, []);
    }
    map.get(key)!.push(message);
  }
  return order.map((key) => {
    const group = map.get(key)!;
    return { conversationId: group[0]!.conversationId, messages: group };
  });
}

function conversationLabel(message: HarvestedMessage | undefined): string {
  if (!message) return "unknown";
  const source = message.source === "cursor" ? "Cursor" : "ChatGPT";
  const title = message.workspace
    ? `${message.workspace}: ${message.conversationTitle ?? message.conversationId}`
    : (message.conversationTitle ?? message.conversationId);
  return `${source}: ${title}`;
}

function formatWhen(timestamp: string | undefined): string {
  if (!timestamp) return "unknown";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function isPlanQuote(quote: string): boolean {
  return /^(i(?:'ll| will|’ll)|let me )\b/i.test(quote.trim());
}

function isHygieneQuote(quote: string): boolean {
  return /\b(worktree|\.env\.local|pre-existing (?:type )?errors?|poll reflexively|block_until_ms|gitignored env)\b/i.test(
    quote,
  );
}

function isOffTopicThread(message: HarvestedMessage): boolean {
  const title = `${message.conversationTitle ?? ""} ${message.workspace ?? ""}`;
  return /\b(fantasy|top 250 rankings|part availability)\b/i.test(title);
}

function containsQuote(content: string, quote: string): boolean {
  const needle = quote.trim();
  if (!needle) return false;
  if (content.includes(needle)) return true;
  const snippet = needle.slice(0, Math.min(80, needle.length));
  return snippet.length >= 12 && content.includes(snippet);
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n\n[truncated]`;
}

function splitByLength(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    pieces.push(text.slice(i, i + max));
  }
  return pieces;
}

function arrayProperty(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return Array.isArray(property) ? property : undefined;
}

function validateStrings(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return "must be an object";
  for (const key of keys) {
    if (typeof value[key] !== "string") return `${key} must be a string`;
    if (!value[key].trim()) return `${key} must not be empty`;
  }
  return undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
