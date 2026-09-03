import assert from "node:assert/strict";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathExists } from "../lib/files.js";
import { runHarvest } from "./harvest.js";

const tmpDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `cutline-harvest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
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

function assistantLine(text: string): string {
  return JSON.stringify({
    role: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

async function writeCursor(
  projectsDir: string,
  id: string,
  body: string,
  mtime?: Date,
): Promise<string> {
  const filePath = path.join(
    projectsDir,
    "Users-chase-projects-snowball",
    "agent-transcripts",
    id,
    `${id}.jsonl`,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  if (mtime) await utimes(filePath, mtime, mtime);
  return filePath;
}

function chatgptConversation(
  id: string,
  title: string,
  seconds: number,
  text: string,
): string {
  return JSON.stringify({
    conversation_id: id,
    title,
    update_time: seconds,
    current_node: `${id}-a`,
    mapping: {
      [`${id}-u`]: {
        id: `${id}-u`,
        parent: null,
        message: {
          id: `${id}-u`,
          author: { role: "user" },
          create_time: seconds,
          content: { parts: [text] },
        },
      },
      [`${id}-a`]: {
        id: `${id}-a`,
        parent: `${id}-u`,
        message: {
          id: `${id}-a`,
          author: { role: "assistant" },
          create_time: seconds + 10,
          content: { parts: ["Noted."] },
        },
      },
    },
  });
}

async function setupDirs(root: string) {
  const projectsDir = path.join(root, "projects");
  const cacheDir = path.join(root, "chatgpt-cache");
  const out = path.join(root, "harvests");
  const statePath = path.join(root, "state.json");
  await mkdir(projectsDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  return { projectsDir, cacheDir, out, statePath };
}

const now = new Date("2026-09-02T19:00:00-07:00");
const recentTs = "Tuesday, Sep 1, 2026, 5:51 PM (UTC-7)";
const recentSec = Date.parse("2026-09-01T18:00:00Z") / 1000;

describe("runHarvest", () => {
  it("initializes checkpoints with no archive when there is no state and no --since", async () => {
    const root = await tmpRoot();
    const { projectsDir, cacheDir, out, statePath } = await setupDirs(root);
    await writeCursor(
      projectsDir,
      "abc",
      `${userLine("History", recentTs)}\n${assistantLine("Old")}\n`,
    );
    await writeFile(
      path.join(cacheDir, "c1.json"),
      chatgptConversation("c1", "History chat", recentSec, "Old chat"),
    );

    const result = await runHarvest({
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now,
      chatgpt: { skipSync: true, cacheDirs: [cacheDir] },
    });

    assert.equal(result.initialized, true);
    assert.equal(result.empty, true);
    assert.equal(result.messages.length, 0);
    assert.equal(await pathExists(out), false);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(Object.keys(state.cursor.files).length, 1);
    assert.ok(state.chatgpt.conversations.c1);
    assert.equal(state.chatgpt.initialized, true);
  });

  it("backfills a lookback window, then harvests only new messages", async () => {
    const root = await tmpRoot();
    const { projectsDir, cacheDir, out, statePath } = await setupDirs(root);
    const cursorPath = await writeCursor(
      projectsDir,
      "abc",
      `${userLine("Day one", recentTs)}\n${assistantLine("Ack")}\n`,
    );
    await writeFile(
      path.join(cacheDir, "c1.json"),
      chatgptConversation("c1", "MCP architecture", recentSec, "What about MCP?"),
    );

    const first = await runHarvest({
      days: 3,
      message: "Worked on Snowball auth",
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now,
      chatgpt: { skipSync: true, cacheDirs: [cacheDir] },
    });

    assert.equal(first.empty, false);
    assert.ok(first.dir);
    assert.equal(first.messages.length, 4);
    const conversations = await readFile(
      path.join(first.dir!, "conversations.md"),
      "utf8",
    );
    assert.match(conversations, /Worked on Snowball auth/);
    assert.match(conversations, /Day one/);
    assert.match(conversations, /What about MCP\?/);

    const noop = await runHarvest({
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now: new Date("2026-09-02T20:00:00-07:00"),
      chatgpt: { skipSync: true, cacheDirs: [cacheDir] },
    });
    assert.equal(noop.empty, true);
    assert.equal(noop.messages.length, 0);

    const laterTs = "Wednesday, Sep 2, 2026, 8:10 PM (UTC-7)";
    const { readFile: read } = await import("node:fs/promises");
    const previous = await read(cursorPath, "utf8");
    await writeFile(
      cursorPath,
      `${previous}${userLine("Day two", laterTs)}\n${assistantLine("More")}\n`,
    );
    const laterSec = Date.parse("2026-09-02T20:10:00Z") / 1000;
    await writeFile(
      path.join(cacheDir, "c1.json"),
      JSON.stringify({
        conversation_id: "c1",
        title: "MCP architecture",
        update_time: laterSec,
        current_node: "c1-u2",
        mapping: {
          "c1-u": {
            id: "c1-u",
            parent: null,
            message: {
              id: "c1-u",
              author: { role: "user" },
              create_time: recentSec,
              content: { parts: ["What about MCP?"] },
            },
          },
          "c1-a": {
            id: "c1-a",
            parent: "c1-u",
            message: {
              id: "c1-a",
              author: { role: "assistant" },
              create_time: recentSec + 10,
              content: { parts: ["Noted."] },
            },
          },
          "c1-u2": {
            id: "c1-u2",
            parent: "c1-a",
            message: {
              id: "c1-u2",
              author: { role: "user" },
              create_time: laterSec,
              content: { parts: ["And the next step?"] },
            },
          },
        },
      }),
    );

    const third = await runHarvest({
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now: new Date("2026-09-02T21:00:00-07:00"),
      chatgpt: { skipSync: true, cacheDirs: [cacheDir] },
    });
    assert.equal(third.empty, false);
    assert.deepEqual(
      third.messages.map((m) => m.content).sort(),
      ["And the next step?", "Day two", "More"].sort(),
    );
  });

  it("does not write state when analysis fails", async () => {
    const root = await tmpRoot();
    const { projectsDir, cacheDir, out, statePath } = await setupDirs(root);
    await writeCursor(
      projectsDir,
      "abc",
      `${userLine("Fail me", recentTs)}\n${assistantLine("Ok")}\n`,
    );
    await writeFile(
      path.join(cacheDir, "c1.json"),
      chatgptConversation("c1", "X", recentSec, "Hi"),
    );

    await assert.rejects(
      () =>
        runHarvest({
          days: 3,
          analyze: true,
          homedir: root,
          cursorProjectsDir: projectsDir,
          statePath,
          out,
          now,
          chatgpt: { skipSync: true, cacheDirs: [cacheDir] },
          analyzeFn: async () => {
            throw new Error("boom");
          },
        }),
      /boom/,
    );

    assert.equal(await pathExists(statePath), false);
    assert.equal(await pathExists(out), false);
  });

  it("seals history outside the first lookback window", async () => {
    const root = await tmpRoot();
    const { projectsDir, cacheDir, out, statePath } = await setupDirs(root);
    await writeCursor(
      projectsDir,
      "old",
      `${userLine("Ancient", "Friday, Aug 1, 2026, 5:51 PM (UTC-7)")}\n`,
      new Date("2026-08-01T12:00:00Z"),
    );
    await writeCursor(
      projectsDir,
      "new",
      `${userLine("Fresh", recentTs)}\n`,
    );
    await writeFile(
      path.join(cacheDir, "old.json"),
      chatgptConversation(
        "oldc",
        "Old chat",
        Date.parse("2026-08-01T18:00:00Z") / 1000,
        "Stale",
      ),
    );
    await writeFile(
      path.join(cacheDir, "new.json"),
      chatgptConversation("newc", "New chat", recentSec, "Fresh chat"),
    );

    const first = await runHarvest({
      days: 3,
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now,
      chatgpt: { skipSync: true, cacheDirs: [cacheDir] },
    });
    assert.deepEqual(
      first.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .sort(),
      ["Fresh", "Fresh chat"].sort(),
    );

    const second = await runHarvest({
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now: new Date("2026-09-02T20:00:00-07:00"),
      chatgpt: { skipSync: true, cacheDirs: [cacheDir] },
    });
    assert.equal(second.empty, true);
  });

  it("does not write state when ChatGPT collection fails", async () => {
    const root = await tmpRoot();
    const { projectsDir, cacheDir, out, statePath } = await setupDirs(root);
    await writeCursor(
      projectsDir,
      "abc",
      `${userLine("Hi", recentTs)}\n`,
    );

    await assert.rejects(
      () =>
        runHarvest({
          days: 3,
          analyze: false,
          homedir: root,
          cursorProjectsDir: projectsDir,
          statePath,
          out,
          now,
          chatgpt: {
            skipSync: false,
            cacheDirs: [cacheDir],
            runChatdump: async () => {
              throw new Error("chatdump exited with code 1.\nlogin required");
            },
          },
        }),
      /login required/,
    );

    assert.equal(await pathExists(statePath), false);
  });

  it("skips ChatGPT when chatdump is missing and still harvests Cursor", async () => {
    const root = await tmpRoot();
    const { projectsDir, cacheDir, out, statePath } = await setupDirs(root);
    await writeCursor(
      projectsDir,
      "abc",
      `${userLine("Cursor only", recentTs)}\n${assistantLine("Ok")}\n`,
    );
    await writeFile(
      path.join(cacheDir, "c1.json"),
      chatgptConversation("c1", "Hidden chat", recentSec, "Should not harvest"),
    );

    const result = await runHarvest({
      days: 3,
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now,
      chatgpt: {
        skipSync: false,
        cacheDirs: [cacheDir],
        runChatdump: async () => {
          throw new Error("chatdump is not installed or not on PATH.");
        },
      },
    });

    assert.equal(result.empty, false);
    assert.deepEqual(
      result.messages.map((m) => m.content).sort(),
      ["Cursor only", "Ok"].sort(),
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.chatgpt.initialized, false);
    assert.deepEqual(state.chatgpt.conversations, {});
  });

  it("seals ChatGPT without dumping history after chatdump is installed later", async () => {
    const root = await tmpRoot();
    const { projectsDir, cacheDir, out, statePath } = await setupDirs(root);
    await writeCursor(
      projectsDir,
      "abc",
      `${userLine("Cursor only", recentTs)}\n`,
    );
    await writeFile(
      path.join(cacheDir, "c1.json"),
      chatgptConversation("c1", "Old chat", recentSec, "History"),
    );

    await runHarvest({
      days: 3,
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now,
      chatgpt: {
        skipSync: false,
        cacheDirs: [cacheDir],
        runChatdump: async () => {
          throw new Error("chatdump is not installed or not on PATH.");
        },
      },
    });

    const later = await runHarvest({
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now: new Date("2026-09-02T20:00:00-07:00"),
      chatgpt: { skipSync: true, cacheDirs: [cacheDir] },
    });

    assert.equal(later.empty, true);
    assert.equal(later.messages.length, 0);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.chatgpt.initialized, true);
    assert.ok(state.chatgpt.conversations.c1);
  });

  it("backfills ChatGPT after chatdump is installed when a lookback window is passed", async () => {
    const root = await tmpRoot();
    const { projectsDir, cacheDir, out, statePath } = await setupDirs(root);
    await writeCursor(
      projectsDir,
      "abc",
      `${userLine("Cursor only", recentTs)}\n`,
    );
    await writeFile(
      path.join(cacheDir, "c1.json"),
      chatgptConversation("c1", "MCP architecture", recentSec, "What about MCP?"),
    );

    await runHarvest({
      days: 3,
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now,
      chatgpt: {
        skipSync: false,
        cacheDirs: [cacheDir],
        runChatdump: async () => {
          throw new Error("chatdump is not installed or not on PATH.");
        },
      },
    });

    const later = await runHarvest({
      days: 3,
      analyze: false,
      homedir: root,
      cursorProjectsDir: projectsDir,
      statePath,
      out,
      now: new Date("2026-09-02T20:00:00-07:00"),
      chatgpt: { skipSync: true, cacheDirs: [cacheDir] },
    });

    assert.equal(later.empty, false);
    assert.deepEqual(
      later.messages.map((m) => m.content).sort(),
      ["Noted.", "What about MCP?"].sort(),
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.chatgpt.initialized, true);
  });
});
