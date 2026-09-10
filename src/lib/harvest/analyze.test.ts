import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WINDOW_CHAR_BUDGET,
  analyzeHarvest,
  countMoments,
  momentWindows,
  stripNoise,
} from "./analyze.js";
import type { HarvestedMessage } from "./types.js";

const exposure: HarvestedMessage = {
  source: "cursor",
  conversationId: "c1",
  messageId: "m1",
  conversationTitle: "Onboarding experiment",
  workspace: "snowball",
  timestamp: "2026-09-03T18:00:00.000Z",
  role: "user",
  content: "The flag was read by users outside the wizard.",
};

const testAccounts: HarvestedMessage = {
  source: "cursor",
  conversationId: "c2",
  conversationTitle: "Metrics audit",
  timestamp: "2026-09-03T19:00:00.000Z",
  role: "user",
  content: "Fifteen of 28 onboarded users were test accounts.",
};

describe("stripNoise", () => {
  it("drops implementation chatter and keeps specific turns", () => {
    const kept = stripNoise([
      exposure,
      {
        source: "cursor",
        conversationId: "c1",
        role: "assistant",
        content: "On it.",
      },
      {
        source: "cursor",
        conversationId: "c1",
        role: "assistant",
        content: "I'll drop email from the stub on line 94 and keep it in the popup.",
      },
      {
        source: "cursor",
        conversationId: "c1",
        role: "assistant",
        content: "```ts\nconst x = 1;\n```\n```ts\nconst y = 2;\n```",
      },
      {
        source: "cursor",
        conversationId: "c1",
        role: "assistant",
        content:
          "The simpler shape is not localStorage. Instead, stop asking the extension which account it is.",
      },
      {
        source: "cursor",
        conversationId: "c1",
        role: "user",
        content: "ok",
      },
    ]);
    assert.deepEqual(
      kept.map((message) => message.content),
      [
        exposure.content,
        "The simpler shape is not localStorage. Instead, stop asking the extension which account it is.",
      ],
    );
  });
});

describe("analyzeHarvest", () => {
  it("clusters quoted moments and keeps a short nearby window", async () => {
    const filler: HarvestedMessage[] = Array.from({ length: 20 }, (_, index) => ({
      source: "cursor" as const,
      conversationId: "c1",
      conversationTitle: "Onboarding experiment",
      workspace: "snowball",
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Filler ${index} ${"x".repeat(200)}`,
    }));
    const thread = [
      ...filler.slice(0, 10),
      exposure,
      {
        source: "cursor" as const,
        conversationId: "c1",
        conversationTitle: "Onboarding experiment",
        workspace: "snowball",
        role: "assistant" as const,
        content: "Exposure must represent the rendered experience.",
      },
      ...filler.slice(10),
    ];
    const calls: string[] = [];
    const result = await analyzeHarvest([...thread, testAccounts], {
      completeJson: async (_system, _user, schemaName) => {
        calls.push(schemaName);
        if (schemaName !== "harvest_moments") {
          throw new Error(`unexpected schema ${schemaName}`);
        }
        if (_user.includes("Fifteen of 28")) {
          return {
            moments: [
              {
                clusterKey: "test-account-metrics",
                tag: "number",
                quote: "Fifteen of 28 onboarded users were test accounts.",
                conversationId: "c2",
              },
            ],
          };
        }
        return {
          moments: [
            {
              clusterKey: "experiment-exposure",
              tag: "failure",
              quote: "The flag was read by users outside the wizard.",
              conversationId: "c1",
            },
            {
              clusterKey: "experiment-exposure",
              tag: "failure",
              quote: "The flag was read by users outside the wizard.",
              conversationId: "c1",
            },
          ],
        };
      },
    });

    assert.ok(calls.every((name) => name === "harvest_moments"));
    assert.ok(calls.length >= 2);
    assert.equal(result.momentCount, 2);
    assert.equal(countMoments(result.momentsMd), 2);
    assert.match(result.momentsMd, /# Harvest brief/);
    assert.match(result.momentsMd, /## Moment 1: experiment-exposure/);
    assert.match(result.momentsMd, /The flag was read by users outside the wizard/);
    assert.match(result.momentsMd, /Fifteen of 28 onboarded users were test accounts/);
    assert.match(result.momentsMd, /### Nearby/);
    assert.match(result.momentsMd, /conversations\.md/);
    assert.doesNotMatch(result.momentsMd, /### What happened/);
    assert.doesNotMatch(result.momentsMd, /### Core insight/);
    assert.doesNotMatch(result.momentsMd, /Filler 0 /);
    assert.ok(result.momentsMd.length < 8_000);
  });

  it("drops invented quotes that are not in the conversation", async () => {
    const result = await analyzeHarvest([exposure], {
      completeJson: async () => ({
        moments: [
          {
            clusterKey: "made-up",
            tag: "opinion",
            quote: "This quote does not exist in the thread.",
            conversationId: "c1",
          },
        ],
      }),
    });
    assert.equal(result.momentCount, 0);
    assert.match(result.momentsMd, /No moments/);
  });

  it("drops worktree hygiene even when the quote is in the thread", async () => {
    let called = 0;
    const result = await analyzeHarvest(
      [
        {
          source: "cursor",
          conversationId: "c1",
          conversationTitle: "Ready to merge?",
          role: "user",
          content: "is this branch ready to merge?",
        },
        {
          source: "cursor",
          conversationId: "c1",
          conversationTitle: "Ready to merge?",
          role: "assistant",
          content:
            "The build failure looks like an environment issue specific to this worktree, likely a missing .env.local.",
        },
      ],
      {
        completeJson: async () => {
          called += 1;
          return {
            moments: [
              {
                clusterKey: "build-failure",
                tag: "failure",
                quote:
                  "The build failure looks like an environment issue specific to this worktree, likely a missing .env.local.",
                conversationId: "c1",
              },
            ],
          };
        },
      },
    );
    assert.ok(called >= 1);
    assert.equal(result.momentCount, 0);
  });

  it("keeps the same cluster key in different conversations as separate moments", async () => {
    const auth: HarvestedMessage = {
      source: "cursor",
      conversationId: "c1",
      conversationTitle: "Auth identity",
      workspace: "snowball",
      role: "user",
      content: "Email was leftover. Identity is JWT sub.",
    };
    const pricing: HarvestedMessage = {
      source: "cursor",
      conversationId: "c2",
      conversationTitle: "Pricing audit",
      workspace: "frex",
      role: "user",
      content: "Verify production pricing before Batch 2.",
    };
    const result = await analyzeHarvest([auth, pricing], {
      completeJson: async (_system, user) => {
        if (user.includes("JWT sub")) {
          return {
            moments: [
              {
                clusterKey: "identity-change",
                tag: "reversal",
                quote: "Email was leftover. Identity is JWT sub.",
                conversationId: "c1",
              },
            ],
          };
        }
        return {
          moments: [
            {
              clusterKey: "identity-change",
              tag: "decision",
              quote: "Verify production pricing before Batch 2.",
              conversationId: "c2",
            },
          ],
        };
      },
    });
    assert.equal(result.momentCount, 2);
    assert.match(result.momentsMd, /Auth identity/);
    assert.match(result.momentsMd, /Pricing audit/);
    assert.match(result.momentsMd, /Email was leftover/);
    assert.match(result.momentsMd, /Verify production pricing/);
  });
});

describe("momentWindows", () => {
  it("keeps every window within the character budget", () => {
    const longUser = "x".repeat(WINDOW_CHAR_BUDGET + 1_000);
    const windows = momentWindows(
      [
        {
          source: "cursor",
          conversationId: "huge",
          conversationTitle: "Huge thread",
          role: "user",
          content: longUser,
        },
        {
          source: "cursor",
          conversationId: "huge",
          conversationTitle: "Huge thread",
          role: "assistant",
          content: "The bug is that exposure counted the wrong users instead.",
        },
        {
          source: "chatgpt",
          conversationId: "other",
          conversationTitle: "Other",
          role: "user",
          content: "short",
        },
      ],
      `${"label-".repeat(200)}`,
    );
    assert.ok(windows.length > 1);
    for (const window of windows) {
      assert.ok(
        window.text.length <= WINDOW_CHAR_BUDGET,
        `${window.text.length} > ${WINDOW_CHAR_BUDGET}`,
      );
    }
  });
});
