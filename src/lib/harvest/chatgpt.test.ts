import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  CHATGPT_SETUP_MESSAGE,
  collectChatgpt,
  harvestConversation,
  linearizeConversation,
} from "./chatgpt.js";
import { emptyHarvestState } from "./types.js";

const tmpDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `cutline-chatgpt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

const recentSec = Date.parse("2026-09-01T18:00:00Z") / 1000;
const oldSec = Date.parse("2026-08-01T18:00:00Z") / 1000;

function conversationJson(options: {
  id: string;
  title: string;
  updateTime: number;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
    createTime: number;
    parent?: string | null;
  }>;
}) {
  const mapping: Record<string, unknown> = {};
  let current = options.messages[options.messages.length - 1]?.id;
  for (const message of options.messages) {
    mapping[message.id] = {
      id: message.id,
      parent: message.parent ?? null,
      message: {
        id: message.id,
        author: { role: message.role },
        create_time: message.createTime,
        content: { parts: [message.text] },
      },
    };
  }
  return {
    conversation_id: options.id,
    title: options.title,
    update_time: options.updateTime,
    current_node: current,
    mapping,
  };
}

describe("chatgpt linearize", () => {
  it("follows current_node and skips system messages", () => {
    const parsed = conversationJson({
      id: "c1",
      title: "MCP architecture",
      updateTime: recentSec,
      messages: [
        {
          id: "sys",
          role: "system",
          text: "ignore",
          createTime: recentSec,
          parent: null,
        },
        {
          id: "m1",
          role: "user",
          text: "What about MCP?",
          createTime: recentSec,
          parent: "sys",
        },
        {
          id: "m2",
          role: "assistant",
          text: "Here is the idea.",
          createTime: recentSec + 60,
          parent: "m1",
        },
      ],
    });
    const lines = linearizeConversation(parsed);
    assert.deepEqual(
      lines.map((l) => l.id),
      ["m1", "m2"],
    );
  });
});

describe("harvestConversation", () => {
  it("returns unseen message IDs", () => {
    const parsed = conversationJson({
      id: "c1",
      title: "MCP",
      updateTime: recentSec,
      messages: [
        {
          id: "m1",
          role: "user",
          text: "Hi",
          createTime: recentSec,
          parent: null,
        },
        {
          id: "m2",
          role: "assistant",
          text: "Hello",
          createTime: recentSec + 1,
          parent: "m1",
        },
      ],
    });
    const result = harvestConversation(parsed, emptyHarvestState(), {
      sealAll: true,
      includeMessages: true,
    });
    assert.equal(result?.harvestedIds.length, 2);
    assert.equal(result?.messages[0]?.conversationTitle, "MCP");
  });

  it("skips already processed message IDs", () => {
    const parsed = conversationJson({
      id: "c1",
      title: "MCP",
      updateTime: recentSec,
      messages: [
        {
          id: "m1",
          role: "user",
          text: "Hi",
          createTime: recentSec,
          parent: null,
        },
        {
          id: "m2",
          role: "assistant",
          text: "Hello",
          createTime: recentSec + 1,
          parent: "m1",
        },
      ],
    });
    const state = emptyHarvestState();
    state.chatgpt.conversations.c1 = { messageIds: ["m1", "m2"] };
    const result = harvestConversation(parsed, state, {
      sealAll: false,
      includeMessages: true,
    });
    assert.equal(result?.messages.length, 0);
    assert.deepEqual(result?.harvestedIds, []);
  });

  it("picks up new messages on an old conversation", () => {
    const parsed = conversationJson({
      id: "c1",
      title: "MCP",
      updateTime: recentSec,
      messages: [
        {
          id: "m1",
          role: "user",
          text: "Hi",
          createTime: oldSec,
          parent: null,
        },
        {
          id: "m2",
          role: "assistant",
          text: "Hello",
          createTime: oldSec + 1,
          parent: "m1",
        },
        {
          id: "m3",
          role: "user",
          text: "Follow up",
          createTime: recentSec,
          parent: "m2",
        },
      ],
    });
    const state = emptyHarvestState();
    state.chatgpt.conversations.c1 = { messageIds: ["m1", "m2"] };
    const result = harvestConversation(parsed, state, {
      sealAll: false,
      includeMessages: true,
    });
    assert.deepEqual(result?.harvestedIds, ["m3"]);
    assert.equal(result?.messages[0]?.content, "Follow up");
  });
});

describe("collectChatgpt", () => {
  it("reads multiple conversations from the cache", async () => {
    const root = await tmpRoot();
    const cache = path.join(root, "cache");
    await mkdir(cache, { recursive: true });
    await writeFile(
      path.join(cache, "c1.json"),
      JSON.stringify(
        conversationJson({
          id: "c1",
          title: "One",
          updateTime: recentSec,
          messages: [
            {
              id: "a",
              role: "user",
              text: "A",
              createTime: recentSec,
              parent: null,
            },
          ],
        }),
      ),
    );
    await writeFile(
      path.join(cache, "c2.json"),
      JSON.stringify(
        conversationJson({
          id: "c2",
          title: "Two",
          updateTime: recentSec,
          messages: [
            {
              id: "b",
              role: "user",
              text: "B",
              createTime: recentSec,
              parent: null,
            },
          ],
        }),
      ),
    );

    const result = await collectChatgpt({
      homedir: root,
      state: emptyHarvestState(),
      collect: { sealAll: true, includeMessages: true },
      deps: { skipSync: true, cacheDirs: [cache] },
    });
    assert.equal(result.messages.length, 2);
    assert.ok(result.conversations.c1);
    assert.ok(result.conversations.c2);
  });

  it("does not duplicate messages already in the checkpoint", async () => {
    const root = await tmpRoot();
    const cache = path.join(root, "cache");
    await mkdir(cache, { recursive: true });
    const payload = conversationJson({
      id: "c1",
      title: "One",
      updateTime: recentSec,
      messages: [
        {
          id: "a",
          role: "user",
          text: "A",
          createTime: recentSec,
          parent: null,
        },
      ],
    });
    await writeFile(path.join(cache, "c1.json"), JSON.stringify(payload));
    const first = await collectChatgpt({
      homedir: root,
      state: emptyHarvestState(),
      collect: { sealAll: true, includeMessages: true },
      deps: { skipSync: true, cacheDirs: [cache] },
    });
    const second = await collectChatgpt({
      homedir: root,
      state: {
        ...emptyHarvestState(),
        chatgpt: { conversations: first.conversations },
      },
      collect: { sealAll: false, includeMessages: true },
      deps: { skipSync: true, cacheDirs: [cache] },
    });
    assert.equal(second.messages.length, 0);
  });

  it("skips malformed conversation JSON", async () => {
    const root = await tmpRoot();
    const cache = path.join(root, "cache");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "bad.json"), "{not json");
    const result = await collectChatgpt({
      homedir: root,
      state: emptyHarvestState(),
      collect: { sealAll: true, includeMessages: true },
      deps: { skipSync: true, cacheDirs: [cache] },
    });
    assert.equal(result.messages.length, 0);
  });

  it("fails when chatdump is missing", async () => {
    await assert.rejects(
      () =>
        collectChatgpt({
          homedir: os.tmpdir(),
          state: emptyHarvestState(),
          collect: { sealAll: true, includeMessages: true },
          deps: {
            skipSync: false,
            cacheDirs: [],
            runChatdump: async () => {
              throw new Error(CHATGPT_SETUP_MESSAGE);
            },
          },
        }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("chatdump is not installed"),
    );
  });
});
