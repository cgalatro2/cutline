import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../files.js";
import type { HarvestedMessage, SourceStats } from "./types.js";
import { sourceStats } from "./types.js";

export type HarvestArchive = {
  id: string;
  createdAt: string;
  message?: string;
  sources: {
    cursor: SourceStats;
    chatgpt: SourceStats;
  };
  messages: HarvestedMessage[];
};

export function harvestIdFromDate(date: Date): string {
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}-${mo}-${d}T${h}${mi}${s}`;
}

export function buildHarvestArchive(
  id: string,
  createdAt: Date,
  messages: HarvestedMessage[],
  label?: string,
): HarvestArchive {
  const cursor = messages.filter((m) => m.source === "cursor");
  const chatgpt = messages.filter((m) => m.source === "chatgpt");
  return {
    id,
    createdAt: createdAt.toISOString(),
    message: label,
    sources: {
      cursor: sourceStats(cursor),
      chatgpt: sourceStats(chatgpt),
    },
    messages,
  };
}

export function renderConversationsMarkdown(
  archive: HarvestArchive,
  createdAt: Date,
): string {
  const lines: string[] = [];
  lines.push(`# Harvest, ${formatLongDate(createdAt)}`);
  lines.push("");
  if (archive.message) {
    lines.push(`Context: ${archive.message}`);
    lines.push("");
  }

  const bySource: Array<{ heading: string; source: HarvestedMessage["source"] }> = [
    { heading: "Cursor", source: "cursor" },
    { heading: "ChatGPT", source: "chatgpt" },
  ];

  for (const { heading, source } of bySource) {
    const grouped = groupConversations(
      archive.messages.filter((m) => m.source === source),
    );
    if (grouped.length === 0) continue;
    lines.push(`## ${heading}`);
    lines.push("");
    for (const group of grouped) {
      lines.push(`### ${conversationHeading(group)}`);
      lines.push("");
      for (const message of group.messages) {
        lines.push(`**${message.role === "user" ? "User" : "Assistant"}**`);
        lines.push("");
        lines.push(message.content);
        lines.push("");
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeHarvestDir(options: {
  outRoot: string;
  id: string;
  harvestJson: string;
  conversationsMd: string;
  momentsMd?: string;
}): Promise<string> {
  const dest = path.join(options.outRoot, options.id);
  const tmp = path.join(options.outRoot, `.${options.id}.tmp`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await writeFile(path.join(tmp, "harvest.json"), options.harvestJson, "utf8");
  await writeFile(
    path.join(tmp, "conversations.md"),
    options.conversationsMd,
    "utf8",
  );
  if (options.momentsMd !== undefined) {
    await writeFile(path.join(tmp, "moments.md"), options.momentsMd, "utf8");
  }
  await ensureDir(options.outRoot);
  await rename(tmp, dest);
  return dest;
}

function groupConversations(
  messages: HarvestedMessage[],
): Array<{ title: string; workspace?: string; messages: HarvestedMessage[] }> {
  const order: string[] = [];
  const map = new Map<string, HarvestedMessage[]>();
  for (const message of messages) {
    if (!map.has(message.conversationId)) {
      order.push(message.conversationId);
      map.set(message.conversationId, []);
    }
    map.get(message.conversationId)!.push(message);
  }
  return order.map((id) => {
    const group = map.get(id)!;
    return {
      title: group[0]?.conversationTitle || id,
      workspace: group[0]?.workspace,
      messages: group,
    };
  });
}

function conversationHeading(group: {
  title: string;
  workspace?: string;
}): string {
  if (group.workspace) return `${group.workspace}: ${group.title}`;
  return group.title;
}

function formatLongDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
