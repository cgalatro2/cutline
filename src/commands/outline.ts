/**
 * `cutline outline` — turn a long-form recording into a structured outline.
 */

export async function runOutline(args: string[]): Promise<void> {
  const [scriptPath, mediaPath] = args;

  if (!scriptPath || !mediaPath) {
    console.error("Usage: cutline outline <script.md> <media>");
    process.exit(1);
  }

  // Scaffolding only — implementation comes next.
  console.log(`outline: script=${scriptPath} media=${mediaPath}`);
  console.log("(not implemented yet)");
}
