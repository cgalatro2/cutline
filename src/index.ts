#!/usr/bin/env node

import { config as loadEnv } from "dotenv";
import { Command } from "commander";
import { runClip } from "./commands/clip.js";
import { resolveHarvestDays, runHarvest } from "./commands/harvest.js";

loadEnv({ quiet: true });

const program = new Command();

program
  .name("cutline")
  .description(
    "Open-source content pipeline for technical creators. Find the publishable ideas inside your work.",
  )
  .version("0.1.0");

program
  .command("harvest")
  .description(
    "Collect new Cursor and ChatGPT work conversations and find publishable ideas",
  )
  .argument("[days]", "Backfill window in days (same as --since)")
  .option("-m, --message <text>", "Optional label for this harvest")
  .option("--since <days>", "Backfill window in days")
  .option("--no-analyze", "Archive without running LLM analysis")
  .option("--out <dir>", "Harvest output directory")
  .action(
    async (
      daysArg: string | undefined,
      opts: {
        message?: string;
        since?: string;
        analyze?: boolean;
        out?: string;
      },
    ) => {
      try {
        const days = resolveHarvestDays(daysArg, opts.since);
        await runHarvest({
          days,
          message: opts.message,
          analyze: opts.analyze !== false,
          out: opts.out,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\nError: ${message}`);
        process.exit(1);
      }
    },
  );

program
  .command("clip")
  .description(
    "Extract audio, transcribe, and find publishable Short/TikTok candidates (script optional)",
  )
  .argument("<video>", "Path to the recording (e.g. demo.mp4)")
  .argument("[script]", "Optional path to a sectioned markdown script")
  .option("-o, --out <dir>", "Output directory", "output")
  .action(async (video: string, script: string | undefined, opts: { out: string }) => {
    try {
      await runClip({ video, script, out: opts.out });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nError: ${message}`);
      process.exit(1);
    }
  });

program.parse();
