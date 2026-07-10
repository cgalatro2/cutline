import { spawn } from "node:child_process";

function run(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "ffmpeg is not installed or not on PATH. Install it (e.g. `brew install ffmpeg`) and try again.",
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `ffmpeg exited with code ${code ?? "unknown"}.\n${stderr.trim()}`,
        ),
      );
    });
  });
}

/** Fail fast with a helpful message if ffmpeg is missing. */
export async function ensureFfmpegAvailable(): Promise<void> {
  try {
    await run("ffmpeg", ["-version"]);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("ffmpeg is not installed")
    ) {
      throw error;
    }
    throw new Error(
      "ffmpeg is not installed or not on PATH. Install it (e.g. `brew install ffmpeg`) and try again.",
    );
  }
}

/**
 * Extract a small mono MP3 from a video for transcription.
 * Does not modify or overwrite the original video.
 */
export async function extractAudio(
  videoPath: string,
  audioPath: string,
): Promise<void> {
  await ensureFfmpegAvailable();
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-b:a",
    "64k",
    audioPath,
  ]);
}
