import OpenAI from "openai";
import { createOpenAIClient } from "../openai.js";
import type { HarvestedMessage } from "./types.js";

const IDEA_MODEL = "gpt-4o-mini";
export const CHUNK_CHAR_BUDGET = 60_000;
const ASSISTANT_CHAR_CAP = 1_200;
const LABEL_CHAR_CAP = 500;

type JsonSchema = Record<string, unknown>;

type CandidateDraft = {
  storyKey: string;
  score: number;
  whatHappened: string;
  whyInteresting: string;
  coreInsight: string;
  disclosureRisk: string;
  source: string;
  evidence: string;
};

type Candidate = CandidateDraft & { id: string };

type ReviewDecision = {
  candidateId: string;
  action: "keep" | "drop" | "merge";
  mergeIntoId: string;
  reason: string;
};

type FinalIdea = {
  storyKey: string;
  score: number;
  whatHappened: string;
  whyInteresting: string;
  coreInsight: string;
  tweet: string;
  tikTok: string;
  youTube: string;
  disclosureRisk: string;
  source: string;
};

type JsonCompletion = (
  system: string,
  user: string,
  schemaName: string,
  schema: JsonSchema,
) => Promise<unknown>;

const CANDIDATE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["storyKey", "score", "whatHappened", "whyInteresting", "coreInsight", "disclosureRisk", "source", "evidence"],
        properties: {
          storyKey: { type: "string" },
          score: { type: "number" },
          whatHappened: { type: "string" },
          whyInteresting: { type: "string" },
          coreInsight: { type: "string" },
          disclosureRisk: { type: "string" },
          source: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

const REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "action", "mergeIntoId", "reason"],
        properties: {
          candidateId: { type: "string" },
          action: { type: "string", enum: ["keep", "drop", "merge"] },
          mergeIntoId: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
};

const CATALOG_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["storyKey", "score", "whatHappened", "whyInteresting", "coreInsight", "tweet", "tikTok", "youTube", "disclosureRisk", "source"],
        properties: {
          storyKey: { type: "string" },
          score: { type: "number" },
          whatHappened: { type: "string" },
          whyInteresting: { type: "string" },
          coreInsight: { type: "string" },
          tweet: { type: "string" },
          tikTok: { type: "string" },
          youTube: { type: "string" },
          disclosureRisk: { type: "string" },
          source: { type: "string" },
        },
      },
    },
  },
};

const EXTRACTOR_PROMPT = `Find every distinct, evidence-backed publishable story candidate in these work conversations.

You are extracting raw material for an editor, not writing final content. Keep candidates with a specific surprise, changed mind, failed approach, strong opinion, product decision, tradeoff, or counterintuitive finding that a builder outside this company would care about.

Drop routine implementation, branch hygiene, agent plans, tool traces, code dumps, generic advice, and anything below 8/10. Do not invent weak candidates to inflate the list.

Use the same short, stable storyKey for candidates about the same underlying story. Evidence must be a direct quote or precise fact from the conversation. Do not make a factual claim the evidence does not support. Source must name the conversation and supplied reference.`;

const REVIEWER_PROMPT = `You are a rigorous editor reviewing candidate stories mined from work conversations.

Return one decision for every candidate ID. Keep every independently publishable candidate. There is no target count. Drop generic advice, routine work, agent-process commentary, unsupported claims, and anything that does not clear 8/10.

Merge candidates only when they tell the same underlying story. Use the most specific candidate as the merge target. Do not merge distinct stories merely because they share a topic such as onboarding, analytics, or feature flags.

For keep and drop, mergeIntoId must be an empty string. For merge, it must be another candidate ID.`;

const EDITOR_PROMPT = `You are the final editor of a technical creator's publishing catalog.

Each supplied story group was approved by a reviewer. Return one final idea for every group. Keep each storyKey unchanged and combine related candidates into one specific, evidence-backed story.

Do not introduce facts absent from the evidence. Prefer a concrete finding over a textbook lesson. Avoid generic advice, hashtags, exclamation-heavy marketing, and the phrases "highlights the importance", "underscores", "crucial", "data integrity", "best practices", and "don't underestimate".

Every idea needs a score from 8.0 to 10.0, a non-empty disclosure risk, and a non-empty source. Set tweet, tikTok, or youTube to an empty string when that format does not fit.`;

export async function analyzeHarvest(
  messages: HarvestedMessage[],
  options: {
    label?: string;
    client?: OpenAI;
    completeJson?: JsonCompletion;
  } = {},
): Promise<{ ideasMd: string; ideaCount: number }> {
  const client = options.client ?? (options.completeJson ? undefined : createOpenAIClient());
  const completeJson =
    options.completeJson ??
    ((system, user, schemaName, schema) =>
      completeJsonWithOpenAI(client!, system, user, schemaName, schema));
  const chunks = chunkConversations(messages, options.label);
  const candidates: Candidate[] = [];

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const result = await requestJson<{ candidates: CandidateDraft[] }>(
      completeJson,
      EXTRACTOR_PROMPT,
      chunk,
      "harvest_candidates",
      CANDIDATE_SCHEMA,
      validateCandidateBatch,
    );
    candidates.push(
      ...result.candidates.map((candidate, candidateIndex) => ({
        ...candidate,
        id: `candidate-${chunkIndex + 1}-${candidateIndex + 1}`,
      })),
    );
  }

  if (candidates.length === 0) {
    return { ideasMd: "No promising ideas.\n", ideaCount: 0 };
  }

  const review = await requestJson<{ decisions: ReviewDecision[] }>(
    completeJson,
    REVIEWER_PROMPT,
    JSON.stringify({ candidates }),
    "harvest_review",
    REVIEW_SCHEMA,
    (value) => validateReviewBatch(value, candidates),
  );
  const stories = approvedStories(candidates, review.decisions);
  if (stories.length === 0) {
    return { ideasMd: "No promising ideas.\n", ideaCount: 0 };
  }

  const catalog = await requestJson<{ ideas: FinalIdea[] }>(
    completeJson,
    EDITOR_PROMPT,
    JSON.stringify({ stories }),
    "harvest_catalog",
    CATALOG_SCHEMA,
    (value) => validateCatalog(value, stories.map((story) => story.storyKey)),
  );
  const ideasMd = renderIdeasMarkdown(catalog.ideas);
  return { ideasMd, ideaCount: catalog.ideas.length };
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
    temperature: 0.3,
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
    throw new Error("OpenAI returned an empty harvest ideas result.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("OpenAI returned invalid JSON for harvest ideas.");
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

export function chunkConversations(
  messages: HarvestedMessage[],
  label?: string,
): string[] {
  const sections = conversationSections(messages);
  if (sections.length === 0) return [];

  const prefix = label ? `Context: ${capText(label.trim(), LABEL_CHAR_CAP)}\n\n` : "";
  const pieceLimit = Math.max(1, CHUNK_CHAR_BUDGET - prefix.length - 1);
  const chunks: string[] = [];
  let current = prefix;

  for (const section of sections) {
    for (const piece of splitByLength(section, pieceLimit)) {
      if (
        current.length > prefix.length &&
        current.length + piece.length + 1 > CHUNK_CHAR_BUDGET
      ) {
        chunks.push(current.trimEnd());
        current = prefix;
      }
      current += `${piece}\n`;
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

export function resequenceIdeas(md: string): string {
  let n = 0;
  return md.replace(/^## Idea[^\n]*/gm, (line) => {
    n += 1;
    const score = line.match(/(\d+(?:\.\d+)?\s*\/\s*10)/);
    return score ? `## Idea ${n} (${score[1]})` : `## Idea ${n}`;
  });
}

export function countIdeas(md: string): number {
  return (md.match(/^## Idea /gm) ?? []).length;
}

export function approvedStories(
  candidates: Candidate[],
  decisions: ReviewDecision[],
): Array<{ storyKey: string; candidates: Candidate[] }> {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const decisionsById = new Map(
    decisions.map((decision) => [decision.candidateId, decision]),
  );
  const stories = new Map<string, Candidate[]>();

  for (const candidate of candidates) {
    const decision = decisionsById.get(candidate.id);
    if (!decision || decision.action === "drop") continue;
    const targetId =
      decision.action === "merge" ? decision.mergeIntoId : candidate.id;
    const target = byId.get(targetId);
    if (!target) continue;
    const group = stories.get(target.storyKey) ?? [];
    group.push(candidate);
    stories.set(target.storyKey, group);
  }

  return [...stories].map(([storyKey, groupedCandidates]) => ({
    storyKey,
    candidates: groupedCandidates,
  }));
}

export function renderIdeasMarkdown(ideas: FinalIdea[]): string {
  if (ideas.length === 0) return "No promising ideas.\n";
  return `${ideas
    .map((idea, index) => {
      const formats = [
        idea.tweet ? `**Tweet**\n${idea.tweet}` : "",
        idea.tikTok ? `**TikTok**\n${idea.tikTok}` : "",
        idea.youTube ? `**YouTube**\n${idea.youTube}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return `## Idea ${index + 1} (${formatScore(idea.score)}/10)

### What happened
${idea.whatHappened}

### Why it's interesting
${idea.whyInteresting}

### Core insight
${idea.coreInsight}

### Content catalog
${formats}

### Disclosure risk
${idea.disclosureRisk}

### Source
${idea.source}`;
    })
    .join("\n\n---\n\n")}\n`;
}

function conversationSections(messages: HarvestedMessage[]): string[] {
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
    const first = group[0]!;
    const source = first.source === "cursor" ? "Cursor" : "ChatGPT";
    const title = first.workspace
      ? `${first.workspace}: ${first.conversationTitle ?? first.conversationId}`
      : (first.conversationTitle ?? first.conversationId);
    const body = group
      .map((m) => {
        const who = m.role === "user" ? "User" : "Assistant";
        const content =
          m.role === "assistant" ? capText(m.content, ASSISTANT_CHAR_CAP) : m.content;
        const reference = [
          `conversation: ${m.conversationId}`,
          m.messageId ? `message: ${m.messageId}` : "",
          m.timestamp ? `time: ${m.timestamp}` : "",
        ]
          .filter(Boolean)
          .join(", ");
        return `**${who}** (${reference})\n\n${content}`;
      })
      .join("\n\n");
    return `## ${source}\n\n### ${title}\n\n${body}\n`;
  });
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

function validateCandidateBatch(value: unknown): string | undefined {
  const candidates = arrayProperty(value, "candidates");
  if (!candidates) return "candidates must be an array";
  for (const candidate of candidates) {
    const problem = validateStrings(candidate, [
      "storyKey",
      "whatHappened",
      "whyInteresting",
      "coreInsight",
      "disclosureRisk",
      "source",
      "evidence",
    ]);
    if (problem) return `candidate ${problem}`;
    if (!hasScore(candidate)) return "candidate score must be between 8 and 10";
  }
  return undefined;
}

function validateReviewBatch(
  value: unknown,
  candidates: Candidate[],
): string | undefined {
  const decisions = arrayProperty(value, "decisions");
  if (!decisions) return "decisions must be an array";
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  if (decisions.length !== candidateIds.size) {
    return "a decision is required for every candidate";
  }

  const seen = new Set<string>();
  const actionById = new Map<string, string>();
  for (const decision of decisions) {
    const problem = validateStrings(decision, ["candidateId", "action", "reason"]);
    if (problem) return `decision ${problem}`;
    if (!isRecord(decision)) return "decision must be an object";
    if (typeof decision.mergeIntoId !== "string") {
      return "decision mergeIntoId must be a string";
    }
    const candidateId = stringProperty(decision, "candidateId")!;
    const action = stringProperty(decision, "action")!;
    const mergeIntoId = stringProperty(decision, "mergeIntoId")!;
    if (!candidateIds.has(candidateId) || seen.has(candidateId)) {
      return "each decision must name one unique candidate ID";
    }
    seen.add(candidateId);
    if (!["keep", "drop", "merge"].includes(action)) {
      return "decision action must be keep, drop, or merge";
    }
    if (
      action === "merge" &&
      (!candidateIds.has(mergeIntoId) || mergeIntoId === candidateId)
    ) {
      return "a merge target must be a different candidate ID";
    }
    if (action !== "merge" && mergeIntoId) {
      return "only merge decisions may set mergeIntoId";
    }
    actionById.set(candidateId, action);
  }

  for (const decision of decisions) {
    if (!isRecord(decision)) return "decision must be an object";
    if (stringProperty(decision, "action") !== "merge") continue;
    const mergeIntoId = stringProperty(decision, "mergeIntoId")!;
    if (actionById.get(mergeIntoId) !== "keep") {
      return "a merge target must be a kept candidate";
    }
  }
  return undefined;
}

function validateCatalog(
  value: unknown,
  expectedStoryKeys: string[],
): string | undefined {
  const ideas = arrayProperty(value, "ideas");
  if (!ideas) return "ideas must be an array";
  if (ideas.length !== expectedStoryKeys.length) {
    return "the catalog must include every approved story exactly once";
  }

  const expected = new Set(expectedStoryKeys);
  const seen = new Set<string>();
  for (const idea of ideas) {
    const problem = validateStrings(idea, [
      "storyKey",
      "whatHappened",
      "whyInteresting",
      "coreInsight",
      "tweet",
      "tikTok",
      "youTube",
      "disclosureRisk",
      "source",
    ]);
    if (problem) return `idea ${problem}`;
    if (!hasScore(idea)) return "idea score must be between 8 and 10";
    const storyKey = stringProperty(idea, "storyKey")!;
    if (!expected.has(storyKey) || seen.has(storyKey)) {
      return "the catalog must use every approved storyKey exactly once";
    }
    seen.add(storyKey);
  }
  return undefined;
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
    if (
      key !== "tweet" &&
      key !== "tikTok" &&
      key !== "youTube" &&
      !value[key].trim()
    ) {
      return `${key} must not be empty`;
    }
  }
  return undefined;
}

function hasScore(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.score === "number" &&
    value.score >= 8 &&
    value.score <= 10
  );
}

function stringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}
