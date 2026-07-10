import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** OpenAI transcription uploads are limited to 25 MB. */
export const OPENAI_AUDIO_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function writeTextFile(
  filePath: string,
  contents: string,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, contents, "utf8");
}

export async function assertReadableFile(
  filePath: string,
  label: string,
): Promise<void> {
  if (!(await pathExists(filePath))) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

export async function assertUnderUploadLimit(
  filePath: string,
  limitBytes = OPENAI_AUDIO_UPLOAD_LIMIT_BYTES,
): Promise<void> {
  const { size } = await stat(filePath);
  if (size <= limitBytes) return;

  const sizeMb = (size / (1024 * 1024)).toFixed(1);
  const limitMb = Math.round(limitBytes / (1024 * 1024));
  throw new Error(
    `Extracted audio is ${sizeMb} MB, which exceeds OpenAI's ${limitMb} MB transcription upload limit.\n` +
      `Try a shorter recording, or re-encode the audio smaller before retrying.`,
  );
}
