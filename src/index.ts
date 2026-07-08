#!/usr/bin/env node

/**
 * cutline — CLI entrypoint
 *
 * Usage (once wired up):
 *   cutline outline script.md demo.mp4
 */

const [, , command, ...args] = process.argv;

if (!command) {
  console.error("Usage: cutline <command> [args...]");
  console.error("");
  console.error("Commands:");
  console.error("  outline   Extract an outline from a recording");
  process.exit(1);
}

switch (command) {
  case "outline": {
    const { runOutline } = await import("./commands/outline.js");
    await runOutline(args);
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
