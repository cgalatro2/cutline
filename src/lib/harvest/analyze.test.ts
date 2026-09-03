import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeHarvest } from "./analyze.js";

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
                storyKey: "experiment-exposure",
                score: 8.8,
                ...candidate,
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
});
