import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildHarvestArchive,
  harvestIdFromDate,
  renderConversationsMarkdown,
  writeHarvestDir,
} from "./archive.js";
import { countMoments, momentWindows, resequenceMoments } from "./analyze.js";
import { resolveHarvestDays } from "../../commands/harvest.js";
import type { HarvestedMessage } from "./types.js";

const sample: HarvestedMessage[] = [
  {
    source: "cursor",
    conversationId: "abc",
    conversationTitle: "Ship harvest",
    workspace: "snowball",
    timestamp: "2026-09-02T00:51:00.000Z",
    role: "user",
    content: "Let's ship harvest",
  },
  {
    source: "cursor",
    conversationId: "abc",
    conversationTitle: "Ship harvest",
    workspace: "snowball",
    timestamp: "2026-09-02T00:51:00.000Z",
    role: "assistant",
    content: "On it.",
  },
  {
    source: "chatgpt",
    conversationId: "c1",
    conversationTitle: "MCP architecture",
    timestamp: "2026-09-01T18:00:00.000Z",
    role: "user",
    content: "What about MCP?",
  },
];

describe("archive", () => {
  it("renders grouped conversations markdown", () => {
    const createdAt = new Date("2026-09-02T19:00:00-07:00");
    const archive = buildHarvestArchive(
      harvestIdFromDate(createdAt),
      createdAt,
      sample,
      "Finished org ownership migration",
    );
    const md = renderConversationsMarkdown(archive, createdAt);
    assert.match(md, /# Harvest, September \d+, 2026/);
    assert.match(md, /Context: Finished org ownership migration/);
    assert.match(md, /## Cursor/);
    assert.match(md, /### snowball: Ship harvest/);
    assert.match(md, /\*\*User\*\*/);
    assert.match(md, /## ChatGPT/);
    assert.match(md, /### MCP architecture/);
    assert.equal(archive.sources.cursor.messageCount, 2);
    assert.equal(archive.sources.chatgpt.conversationCount, 1);
  });

  it("writes harvest files via a temp directory", async () => {
    const outRoot = path.join(
      os.tmpdir(),
      `cutline-archive-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const dir = await writeHarvestDir({
      outRoot,
      id: "2026-09-02T175012",
      harvestJson: "{}\n",
      conversationsMd: "# hi\n",
      momentsMd: "## Moment 1\n",
    });
    assert.equal(path.basename(dir), "2026-09-02T175012");
    assert.equal(await readFile(path.join(dir, "conversations.md"), "utf8"), "# hi\n");
    const { rm } = await import("node:fs/promises");
    await rm(outRoot, { recursive: true, force: true });
  });
});

describe("analyze helpers", () => {
  it("windows by conversation", () => {
    const windows = momentWindows(sample, "label");
    assert.equal(windows.length, 2);
    assert.match(windows[0]?.text ?? "", /Context: label/);
    assert.match(windows[0]?.text ?? "", /Let's ship harvest/);
    assert.doesNotMatch(windows[0]?.text ?? "", /On it/);
  });

  it("resequences moment headings", () => {
    const md = resequenceMoments("## Moment 1: a\n\n## Moment 1: b\n");
    assert.match(md, /## Moment 1: a/);
    assert.match(md, /## Moment 2: b/);
    assert.equal(countMoments(md), 2);
  });
});

describe("resolveHarvestDays", () => {
  it("accepts a positional integer", () => {
    assert.equal(resolveHarvestDays("3", undefined), 3);
    assert.equal(resolveHarvestDays(undefined, "7"), 7);
    assert.equal(resolveHarvestDays(undefined, undefined), undefined);
  });

  it("rejects a non-integer positional", () => {
    assert.throws(() => resolveHarvestDays("nope", undefined), /positive integer/);
  });

  it("rejects conflicting values", () => {
    assert.throws(() => resolveHarvestDays("3", "7"), /not both/);
  });
});
