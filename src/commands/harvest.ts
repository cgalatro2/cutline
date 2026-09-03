import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeHarvest } from "../lib/harvest/analyze.js";
import {
  buildHarvestArchive,
  harvestIdFromDate,
  renderConversationsMarkdown,
  writeHarvestDir,
} from "../lib/harvest/archive.js";
import {
  collectChatgpt,
  isChatdumpMissing,
  type ChatgptCollectResult,
  type ChatgptDeps,
} from "../lib/harvest/chatgpt.js";
import { collectCursor, defaultCursorProjectsDir } from "../lib/harvest/cursor.js";
import {
  checkpointsEqual,
  defaultHarvestsDir,
  defaultStatePath,
  readHarvestState,
  writeHarvestState,
} from "../lib/harvest/state.js";
import {
  emptyHarvestState,
  sortMessages,
  sourceStats,
  type HarvestCollectOptions,
  type HarvestState,
  type HarvestedMessage,
} from "../lib/harvest/types.js";
import { createOpenAIClient, requireApiKey } from "../lib/openai.js";

export type HarvestOptions = {
  days?: number;
  message?: string;
  analyze: boolean;
  out?: string;
  homedir?: string;
  cursorProjectsDir?: string;
  statePath?: string;
  now?: Date;
  chatgpt?: ChatgptDeps;
  writeState?: (statePath: string, state: HarvestState) => Promise<void>;
  analyzeFn?: (messages: HarvestedMessage[], label?: string) => Promise<{
    ideasMd: string;
    ideaCount: number;
  }>;
};

export type HarvestRunResult = {
  id?: string;
  dir?: string;
  messages: HarvestedMessage[];
  initialized: boolean;
  empty: boolean;
  state: HarvestState;
};

export async function runHarvest(
  options: HarvestOptions,
): Promise<HarvestRunResult> {
  const homedir = options.homedir ?? os.homedir();
  const now = options.now ?? new Date();
  const statePath = options.statePath ?? defaultStatePath(homedir);
  const outRoot = options.out
    ? path.resolve(options.out)
    : defaultHarvestsDir(homedir);
  const projectsDir =
    options.cursorProjectsDir ?? defaultCursorProjectsDir(homedir);
  const sinceMs =
    options.days !== undefined
      ? now.getTime() - options.days * 24 * 60 * 60 * 1000
      : undefined;

  const { state: current, existed } = await readHarvestState(statePath);
  const cursorCollect = collectOptions(!existed, sinceMs);
  const chatgptCollect = collectOptions(!current.chatgpt.initialized, sinceMs);

  console.log("Scanning Cursor...");
  const cursor = await collectCursor({
    projectsDir,
    state: current,
    collect: cursorCollect,
  });
  const cursorStats = sourceStats(cursor.messages);
  console.log(`  ${cursorStats.conversationCount} updated conversations`);
  console.log(`  ${cursorStats.messageCount} new messages`);

  console.log("\nSyncing ChatGPT...");
  const chatgpt = await collectChatgptOrSkip({
    homedir,
    state: current,
    collect: chatgptCollect,
    deps: options.chatgpt,
  });
  if (!chatgpt.skipped) {
    const chatgptStats = sourceStats(chatgpt.messages);
    console.log(`  ${chatgptStats.conversationCount} updated conversations`);
    console.log(`  ${chatgptStats.messageCount} new messages`);
  }

  const proposed: HarvestState = {
    version: 1,
    cursor: { files: cursor.files },
    chatgpt: {
      conversations: chatgpt.conversations,
      initialized: chatgpt.skipped ? current.chatgpt.initialized : true,
    },
    lastSuccessfulHarvestAt: now.toISOString(),
  };

  const messages = sortMessages([...cursor.messages, ...chatgpt.messages]);

  if (!existed && sinceMs === undefined) {
    await writeHarvestState(statePath, proposed);
    console.log("\nInitialized harvest checkpoints.");
    console.log("No messages harvested. Next `cutline harvest` will collect new work.");
    console.log("To backfill recent threads: cutline harvest 3");
    return {
      messages: [],
      initialized: true,
      empty: true,
      state: proposed,
    };
  }

  if (messages.length === 0) {
    if (!existed) {
      await writeHarvestState(statePath, proposed);
      console.log(
        `\nNo Cursor or ChatGPT messages in the last ${options.days} days.`,
      );
      console.log("Checkpoint saved. Later harvests will collect new work.");
      return {
        messages: [],
        initialized: true,
        empty: true,
        state: proposed,
      };
    }

    const unchanged = checkpointsEqual(
      { ...emptyHarvestState(), cursor: current.cursor, chatgpt: current.chatgpt },
      { ...emptyHarvestState(), cursor: proposed.cursor, chatgpt: proposed.chatgpt },
    );
    console.log("\nNo new Cursor or ChatGPT messages since the previous harvest.");
    const persisted = unchanged
      ? current
      : {
          ...proposed,
          lastSuccessfulHarvestAt: current.lastSuccessfulHarvestAt,
        };
    if (!unchanged) {
      await writeHarvestState(statePath, persisted);
      console.log("Checkpoint saved.");
    }
    return {
      messages: [],
      initialized: false,
      empty: true,
      state: persisted,
    };
  }

  console.log(`\nHarvested ${messages.length} new messages.`);

  let ideasMd: string | undefined;
  let ideaCount = 0;
  if (options.analyze) {
    if (!options.analyzeFn) requireApiKey();
    console.log("\nFinding publishable ideas...");
    const result = options.analyzeFn
      ? await options.analyzeFn(messages, options.message)
      : await analyzeHarvest(messages, {
          label: options.message,
          client: createOpenAIClient(),
        });
    ideasMd = result.ideasMd;
    ideaCount = result.ideaCount;
    if (ideaCount === 0) {
      console.log("  No promising ideas found");
    } else {
      console.log(
        `  ${ideaCount} promising idea${ideaCount === 1 ? "" : "s"} found`,
      );
    }
  }

  const id = harvestIdFromDate(now);
  const archive = buildHarvestArchive(id, now, messages, options.message);
  const conversationsMd = renderConversationsMarkdown(archive, now);
  const persistState = options.writeState ?? writeHarvestState;
  const dir = await writeHarvestDir({
    outRoot,
    id,
    harvestJson: `${JSON.stringify(archive, null, 2)}\n`,
    conversationsMd,
    ideasMd,
  });
  try {
    await persistState(statePath, proposed);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  console.log(`\nWrote ${path.join(dir, "conversations.md")}`);
  if (ideasMd !== undefined) {
    console.log(`Wrote ${path.join(dir, "ideas.md")}`);
  }
  console.log("\nCheckpoint saved.");

  return {
    id,
    dir,
    messages,
    initialized: !existed,
    empty: false,
    state: proposed,
  };
}

export function resolveHarvestDays(
  positional: string | undefined,
  since: string | undefined,
): number | undefined {
  if (positional !== undefined && since !== undefined && positional !== since) {
    throw new Error(
      "Pass the day window as `cutline harvest 3` or `--since 3`, not both.",
    );
  }
  const raw = positional ?? since;
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      "Days must be a positive integer, for example: cutline harvest 3",
    );
  }
  return Number(raw);
}

function collectOptions(
  firstRun: boolean,
  sinceMs: number | undefined,
): HarvestCollectOptions {
  return {
    sinceMs,
    sealAll: firstRun,
    includeMessages: !(firstRun && sinceMs === undefined),
  };
}

async function collectChatgptOrSkip(options: {
  homedir: string;
  state: HarvestState;
  collect: HarvestCollectOptions;
  deps?: ChatgptDeps;
}): Promise<ChatgptCollectResult & { skipped: boolean }> {
  try {
    const result = await collectChatgpt(options);
    return { ...result, skipped: false };
  } catch (error) {
    if (!isChatdumpMissing(error)) throw error;
    console.log("  Skipped. chatdump is not installed.");
    console.log(
      "  Install from https://github.com/combinatrix-ai/chatdump to include ChatGPT.",
    );
    return {
      messages: [],
      conversations: options.state.chatgpt.conversations,
      skipped: true,
    };
  }
}
