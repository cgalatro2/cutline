import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

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
