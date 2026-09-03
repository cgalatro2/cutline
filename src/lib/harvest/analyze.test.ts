import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHUNK_CHAR_BUDGET, analyzeHarvest, chunkConversations } from "./analyze.js";

const candidate = {
  storyKey: "experiment-exposure",
  score: 8.5,
  whatHappened: "The default event counted users who never saw the experiment.",
  whyInteresting: "The experiment population was contaminated.",
  coreInsight: "Exposure must represent the rendered experience.",
  disclosureRisk: "Abstract the product and user details.",
  source: "Cursor: onboarding experiment (conversation: c1)",
  evidence: "The flag was read by users outside the wizard.",
};

describe("analyzeHarvest", () => {
  it("merges reviewed duplicates and renders every approved story", async () => {
    const calls: string[] = [];
    const result = await analyzeHarvest(
      [
        {
          source: "cursor",
          conversationId: "c1",
          messageId: "m1",
          conversationTitle: "Onboarding experiment",
          timestamp: "2026-09-03T18:00:00.000Z",
          role: "user",
          content: "The flag was read by users outside the wizard.",
        },
      ],
      {
        completeJson: async (_system, _user, schemaName) => {
          calls.push(schemaName);
          if (schemaName === "harvest_candidates") {
            return {
              candidates: [
                candidate,
                {
                  ...candidate,
                  score: 9,
                  whatHappened: "The pre-auth ID and user ID had different variants.",
                },
                {
                  ...candidate,
                  storyKey: "test-account-metrics",
                  whatHappened: "Fifteen of 28 onboarded users were test accounts.",
                  coreInsight: "Verify the population before explaining a metric.",
                },
              ],
            };
          }
          if (schemaName === "harvest_review") {
            return {
              decisions: [
                {
                  candidateId: "candidate-1-1",
                  action: "keep",
                  mergeIntoId: "",
                  reason: "The most specific experiment story.",
                },
                {
                  candidateId: "candidate-1-2",
                  action: "merge",
                  mergeIntoId: "candidate-1-1",
                  reason: "A second detail of the same experiment failure.",
                },
                {
                  candidateId: "candidate-1-3",
                  action: "keep",
                  mergeIntoId: "",
                  reason: "A distinct and concrete analytics finding.",
                },
              ],
            };
          }
          return {
            ideas: [
              {
                ...candidate,
                storyKey: "experiment-exposure",
                score: 8.8,
                tweet: "We killed an experiment when the flag reached users outside the wizard.",
                tikTok: "",
                youTube: "How we learned our exposure event was not exposure.",
              },
              {
                ...candidate,
                storyKey: "test-account-metrics",
                score: 8.2,
                whatHappened: "Fifteen of 28 onboarded users were test accounts.",
                coreInsight: "Verify the population before explaining a metric.",
                tweet: "15 of 28 onboarded users were test accounts.",
                tikTok: "",
                youTube: "",
              },
            ],
          };
        },
      },
    );

    assert.deepEqual(calls, [
      "harvest_candidates",
      "harvest_review",
      "harvest_catalog",
    ]);
    assert.equal(result.ideaCount, 2);
    assert.equal((result.ideasMd.match(/^## Idea /gm) ?? []).length, 2);
    assert.match(result.ideasMd, /### Disclosure risk/);
    assert.match(result.ideasMd, /### Source/);
    assert.doesNotMatch(result.ideasMd, /### Content catalog\n\n###/);
  });

  it("rejects merge targets that are dropped, chained, or cyclic", async () => {
    const message = {
      source: "cursor" as const,
      conversationId: "c1",
      role: "user" as const,
      content: "The flag was read by users outside the wizard.",
    };
    const candidates = [
      candidate,
      { ...candidate, storyKey: "variant-b" },
      { ...candidate, storyKey: "variant-c" },
    ];
    const cases = [
      [
        {
          candidateId: "candidate-1-1",
          action: "merge",
          mergeIntoId: "candidate-1-2",
          reason: "Merge into a dropped story.",
        },
        {
          candidateId: "candidate-1-2",
          action: "drop",
          mergeIntoId: "",
          reason: "Dropped.",
        },
        {
          candidateId: "candidate-1-3",
          action: "keep",
          mergeIntoId: "",
          reason: "Keep.",
        },
      ],
      [
        {
          candidateId: "candidate-1-1",
          action: "merge",
          mergeIntoId: "candidate-1-2",
          reason: "Chain start.",
        },
        {
          candidateId: "candidate-1-2",
          action: "merge",
          mergeIntoId: "candidate-1-3",
          reason: "Chain middle.",
        },
        {
          candidateId: "candidate-1-3",
          action: "keep",
          mergeIntoId: "",
          reason: "Keep.",
        },
      ],
      [
        {
          candidateId: "candidate-1-1",
          action: "merge",
          mergeIntoId: "candidate-1-2",
          reason: "Cycle a.",
        },
        {
          candidateId: "candidate-1-2",
          action: "merge",
          mergeIntoId: "candidate-1-1",
          reason: "Cycle b.",
        },
        {
          candidateId: "candidate-1-3",
          action: "keep",
          mergeIntoId: "",
          reason: "Keep.",
        },
      ],
    ];

    for (const decisions of cases) {
      await assert.rejects(
        () =>
          analyzeHarvest([message], {
            completeJson: async (_system, _user, schemaName) => {
              if (schemaName === "harvest_candidates") {
                return { candidates };
              }
              return { decisions };
            },
          }),
        /merge target must be a kept candidate/,
      );
    }
  });
});

describe("chunkConversations", () => {
  it("keeps every chunk within the character budget", () => {
    const longUser = "x".repeat(CHUNK_CHAR_BUDGET + 1_000);
    const longAssistant = "y".repeat(5_000);
    const chunks = chunkConversations(
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
          content: longAssistant,
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
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= CHUNK_CHAR_BUDGET, `${chunk.length} > ${CHUNK_CHAR_BUDGET}`);
    }
  });
});
