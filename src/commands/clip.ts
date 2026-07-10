import path from "node:path";
import {
  assertReadableFile,
  assertUnderUploadLimit,
  ensureDir,
  readTextFile,
  writeTextFile,
} from "../lib/files.js";
import { extractAudio } from "../lib/ffmpeg.js";
import {
  createOpenAIClient,
  formatTimestampedTranscript,
  generatePublishableClips,
  requireApiKey,
  transcribeAudio,
} from "../lib/openai.js";

export type ClipOptions = {
  /** Optional sectioned script. Omit for ad-hoc / video-only runs. */
  script?: string;
  video: string;
  out: string;
};

export async function runClip(options: ClipOptions): Promise<void> {
  const videoPath = path.resolve(options.video);
  const outDir = path.resolve(options.out);
  const scriptPath = options.script
    ? path.resolve(options.script)
    : undefined;

  if (scriptPath) {
    await assertReadableFile(scriptPath, "Script");
  }
  await assertReadableFile(videoPath, "Video");
  requireApiKey();
  await ensureDir(outDir);

  const audioPath = path.join(outDir, "audio.mp3");
  const transcriptPath = path.join(outDir, "transcript.md");
  const clipsPath = path.join(outDir, "publishable-clips.md");

  let script: string | undefined;
  if (scriptPath) {
    console.log("Reading script…");
    script = await readTextFile(scriptPath);
  } else {
    console.log(
      "No script provided — finding publishable ideas from transcript only.",
    );
  }

  console.log("Extracting audio with ffmpeg…");
  await extractAudio(videoPath, audioPath);
  console.log(`  → ${audioPath}`);
  await assertUnderUploadLimit(audioPath);

  console.log("Transcribing with OpenAI (segment timestamps)…");
  const client = createOpenAIClient();
  const { segments } = await transcribeAudio(client, audioPath);
  const timestampedTranscript = formatTimestampedTranscript(segments);
  await writeTextFile(transcriptPath, `${timestampedTranscript}\n`);
  console.log(`  → ${transcriptPath}`);

  console.log("Finding publishable ideas…");
  const clips = await generatePublishableClips(
    client,
    timestampedTranscript,
    script,
  );
  await writeTextFile(clipsPath, `${clips}\n`);
  console.log(`  → ${clipsPath}`);

  console.log(
    "\nDone. Review publishable-clips.md — your first-draft publishing queue.",
  );
}
