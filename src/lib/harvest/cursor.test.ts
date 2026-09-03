import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, rm, stat, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  collectCursor,
  parseCursorTimestamp,
  splitCompleteLines,
  titleFromQuery,
  workspaceFromProjectSlug,
} from "./cursor.js";
import { emptyHarvestState, type HarvestCollectOptions } from "./types.js";

const tmpDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `cutline-cursor-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function userLine(query: string, timestamp: string): string {
  return JSON.stringify({
    role: "user",
    message: {
      content: [
        {
          type: "text",
          text: `<timestamp>${timestamp}</timestamp>\n<user_query>${query}</user_query>`,
        },
      ],
    },
  });
}

function assistantLine(text: string, tools = false): string {
  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  if (tools) {
    content.push({ type: "tool_use", name: "Read", input: { path: "x.ts" } });
  }
  return JSON.stringify({ role: "assistant", message: { content } });
}

function toolOnlyLine(): string {
  return JSON.stringify({
    role: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Read", input: { path: "x.ts" } }],
    },
  });
}

async function writeTranscript(
  projectsDir: string,
  slug: string,
  id: string,
  body: string,
  mtime?: Date,
): Promise<string> {
  const filePath = path.join(
    projectsDir,
    slug,
    "agent-transcripts",
    id,
    `${id}.jsonl`,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  if (mtime) await utimes(filePath, mtime, mtime);
  return filePath;
}

const archiveAll: HarvestCollectOptions = {
  sealAll: true,
  includeMessages: true,
};

describe("cursor helpers", () => {
  it("parses Cursor timestamp tags", () => {
    const iso = parseCursorTimestamp("Wednesday, Sep 2, 2026, 5:51 PM (UTC-7)");
    assert.ok(iso);
    const date = new Date(iso);
    assert.equal(date.getUTCFullYear(), 2026);
    assert.equal(date.getUTCMonth(), 8);
    assert.equal(date.getUTCDate(), 3);
    assert.equal(date.getUTCHours(), 0);
    assert.equal(date.getUTCMinutes(), 51);
  });

  it("derives workspace from a project slug", () => {
    assert.equal(
      workspaceFromProjectSlug("Users-chase-projects-snowball"),
      "snowball",
    );
  });

  it("truncates titles", () => {
    assert.equal(titleFromQuery("short"), "short");
    assert.equal(titleFromQuery(`${"a".repeat(90)}`).length, 80);
  });

  it("keeps the last complete JSONL line offset", () => {
    const chunk = '{"a":1}\n{"b":2}';
    const { lines, newOffset } = splitCompleteLines(chunk, 10);
    assert.deepEqual(lines, ['{"a":1}']);
    assert.equal(newOffset, 10 + Buffer.byteLength('{"a":1}\n', "utf8"));
  });

  it("advances offsets by UTF-8 byte length", () => {
    const line = '{"t":"café"}\n';
    const rest = '{"x":1}';
    const { lines, newOffset } = splitCompleteLines(`${line}${rest}`, 0);
    assert.deepEqual(lines, ['{"t":"café"}']);
    assert.equal(newOffset, Buffer.byteLength(line, "utf8"));
    assert.notEqual(newOffset, line.length);
  });
});

describe("collectCursor", () => {
  it("reads a full transcript on the first run", async () => {
    const root = await tmpRoot();
    const projectsDir = path.join(root, "projects");
    const ts = "Wednesday, Sep 2, 2026, 5:51 PM (UTC-7)";
    const filePath = await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "abc",
      [
        userLine("Ship harvest", ts),
        assistantLine("On it", true),
        '{"type":"turn_ended","status":"success"}',
        toolOnlyLine(),
        "",
      ].join("\n") + "\n",
    );

    const result = await collectCursor({
      projectsDir,
      state: emptyHarvestState(),
      collect: archiveAll,
    });

    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0]?.role, "user");
    assert.equal(result.messages[0]?.content, "Ship harvest");
    assert.equal(result.messages[0]?.workspace, "snowball");
    assert.equal(result.messages[1]?.role, "assistant");
    assert.equal(result.messages[1]?.content, "On it");
    const { size } = await stat(filePath);
    assert.equal(result.files[filePath]?.offset, size);
  });

  it("reads only appended JSONL on the second run", async () => {
    const root = await tmpRoot();
    const projectsDir = path.join(root, "projects");
    const ts = "Wednesday, Sep 2, 2026, 5:51 PM (UTC-7)";
    const first = [
      userLine("One", ts),
      assistantLine("Two"),
    ].join("\n") + "\n";
    const filePath = await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "abc",
      first,
    );

    const firstRun = await collectCursor({
      projectsDir,
      state: emptyHarvestState(),
      collect: archiveAll,
    });
    const extra = [
      userLine("Three", ts),
      assistantLine("Four"),
    ].join("\n") + "\n";
    await writeFile(filePath, first + extra);

    const second = await collectCursor({
      projectsDir,
      state: {
        ...emptyHarvestState(),
        cursor: { files: firstRun.files },
      },
      collect: { sealAll: false, includeMessages: true },
    });

    assert.equal(second.messages.length, 2);
    assert.equal(second.messages[0]?.content, "Three");
    assert.equal(second.messages[1]?.content, "Four");
  });

  it("resumes after a multi-byte line using a byte offset", async () => {
    const root = await tmpRoot();
    const projectsDir = path.join(root, "projects");
    const ts = "Wednesday, Sep 2, 2026, 5:51 PM (UTC-7)";
    const first = `${userLine("café 🎯", ts)}\n`;
    const filePath = await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "abc",
      first,
    );
    assert.notEqual(Buffer.byteLength(first, "utf8"), first.length);

    const firstRun = await collectCursor({
      projectsDir,
      state: emptyHarvestState(),
      collect: archiveAll,
    });
    const { size } = await stat(filePath);
    assert.equal(firstRun.files[filePath]?.offset, size);

    const extra = `${userLine("next", ts)}\n`;
    await writeFile(filePath, first + extra);
    const second = await collectCursor({
      projectsDir,
      state: {
        ...emptyHarvestState(),
        cursor: { files: firstRun.files },
      },
      collect: { sealAll: false, includeMessages: true },
    });
    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0]?.content, "next");
  });

  it("picks up a new transcript between runs", async () => {
    const root = await tmpRoot();
    const projectsDir = path.join(root, "projects");
    const ts = "Wednesday, Sep 2, 2026, 5:51 PM (UTC-7)";
    await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "aaa",
      `${userLine("A", ts)}\n`,
    );
    const first = await collectCursor({
      projectsDir,
      state: emptyHarvestState(),
      collect: archiveAll,
    });
    await writeTranscript(
      projectsDir,
      "Users-chase-projects-cutline",
      "bbb",
      `${userLine("B", ts)}\n`,
    );
    const second = await collectCursor({
      projectsDir,
      state: { ...emptyHarvestState(), cursor: { files: first.files } },
      collect: { sealAll: false, includeMessages: true },
    });
    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0]?.content, "B");
    assert.equal(second.messages[0]?.workspace, "cutline");
  });

  it("returns nothing for an unchanged transcript", async () => {
    const root = await tmpRoot();
    const projectsDir = path.join(root, "projects");
    const ts = "Wednesday, Sep 2, 2026, 5:51 PM (UTC-7)";
    await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "abc",
      `${userLine("Hi", ts)}\n`,
    );
    const first = await collectCursor({
      projectsDir,
      state: emptyHarvestState(),
      collect: archiveAll,
    });
    const second = await collectCursor({
      projectsDir,
      state: { ...emptyHarvestState(), cursor: { files: first.files } },
      collect: { sealAll: false, includeMessages: true },
    });
    assert.equal(second.messages.length, 0);
  });

  it("treats a truncated file as new", async () => {
    const root = await tmpRoot();
    const projectsDir = path.join(root, "projects");
    const ts = "Wednesday, Sep 2, 2026, 5:51 PM (UTC-7)";
    const filePath = await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "abc",
      `${userLine("Long original", ts)}\n${assistantLine("Reply")}\n`,
    );
    const first = await collectCursor({
      projectsDir,
      state: emptyHarvestState(),
      collect: archiveAll,
    });
    await writeFile(filePath, `${userLine("Replaced", ts)}\n`);
    const second = await collectCursor({
      projectsDir,
      state: { ...emptyHarvestState(), cursor: { files: first.files } },
      collect: { sealAll: false, includeMessages: true },
    });
    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0]?.content, "Replaced");
  });

  it("skips a malformed JSONL line and continues", async () => {
    const root = await tmpRoot();
    const projectsDir = path.join(root, "projects");
    const ts = "Wednesday, Sep 2, 2026, 5:51 PM (UTC-7)";
    await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "abc",
      `${userLine("Ok", ts)}\nNOT JSON\n${assistantLine("Still here")}\n`,
    );
    const result = await collectCursor({
      projectsDir,
      state: emptyHarvestState(),
      collect: archiveAll,
    });
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[1]?.content, "Still here");
  });

  it("does not harvest an incomplete last line", async () => {
    const root = await tmpRoot();
    const projectsDir = path.join(root, "projects");
    const ts = "Wednesday, Sep 2, 2026, 5:51 PM (UTC-7)";
    const complete = `${userLine("Done", ts)}\n`;
    const filePath = await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "abc",
      `${complete}{"role":"assistant","message":{"content":[{"type":"text","text":"partial"`,
    );
    const result = await collectCursor({
      projectsDir,
      state: emptyHarvestState(),
      collect: archiveAll,
    });
    assert.equal(result.messages.length, 1);
    assert.equal(result.files[filePath]?.offset, complete.length);
  });

  it("skips subagent transcripts", async () => {
    const root = await tmpRoot();
    const projectsDir = path.join(root, "projects");
    const ts = "Wednesday, Sep 2, 2026, 5:51 PM (UTC-7)";
    await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "abc",
      `${userLine("Parent", ts)}\n`,
    );
    const sub = path.join(
      projectsDir,
      "Users-chase-projects-snowball",
      "agent-transcripts",
      "abc",
      "subagents",
      "sub.jsonl",
    );
    await mkdir(path.dirname(sub), { recursive: true });
    await writeFile(sub, `${userLine("Subagent secret", ts)}\n`);
    const result = await collectCursor({
      projectsDir,
      state: emptyHarvestState(),
      collect: archiveAll,
    });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]?.content, "Parent");
  });

  it("keeps recent messages and seals older files on first lookback", async () => {
    const root = await tmpRoot();
    const projectsDir = path.join(root, "projects");
    const recent = "Tuesday, Sep 1, 2026, 5:51 PM (UTC-7)";
    const old = "Friday, Aug 1, 2026, 5:51 PM (UTC-7)";
    const oldDate = new Date("2026-08-01T12:00:00Z");
    const recentPath = await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "new",
      `${userLine("Recent work", recent)}\n`,
    );
    const oldPath = await writeTranscript(
      projectsDir,
      "Users-chase-projects-snowball",
      "old",
      `${userLine("Ancient", old)}\n`,
      oldDate,
    );

    const sinceMs = Date.parse("2026-08-30T00:00:00-07:00");
    const result = await collectCursor({
      projectsDir,
      state: emptyHarvestState(),
      collect: { sinceMs, sealAll: true, includeMessages: true },
    });

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]?.content, "Recent work");
    assert.equal(result.files[recentPath]?.offset, (await stat(recentPath)).size);
    assert.equal(result.files[oldPath]?.offset, (await stat(oldPath)).size);
  });
});
