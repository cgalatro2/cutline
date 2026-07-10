#!/usr/bin/env node

import { config as loadEnv } from "dotenv";
import { Command } from "commander";
import { runClip } from "./commands/clip.js";

loadEnv({ quiet: true });

const program = new Command();

program
  .name("cutline")
  .description(
    "Open-source content pipeline for technical creators — find the publishable ideas inside a recording.",
  )
  .version("0.1.0");

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
