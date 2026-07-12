import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DownloadedFile } from "./telegram-file.js";

export const DOCUMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function safeFilename(filename: string | undefined): string {
  const normalized = path.basename(filename || "document")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return normalized || "document";
}

/** Persist an attachment where the on-Pi Hugin worker can read it by path. */
export async function storeDocument(
  root: string,
  file: DownloadedFile,
  originalFilename?: string
): Promise<string> {
  await pruneDocumentStore(root);
  const directory = path.join(root, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const localPath = path.join(directory, safeFilename(originalFilename || file.filename));
  await writeFile(localPath, file.buffer, { mode: 0o600, flag: "wx" });
  return localPath;
}

/** Best-effort retention sweep; ready-task files live long enough for Hugin. */
export async function pruneDocumentStore(
  root: string,
  now = Date.now()
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = path.join(root, entry.name);
        let metadata;
        try {
          metadata = await stat(directory);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
          throw err;
        }
        if (metadata.mtimeMs < now - DOCUMENT_RETENTION_MS) {
          await rm(directory, { recursive: true, force: true });
        }
      })
  );
}

/** Delete an attachment that never became a Hugin task. */
export async function removeStoredDocument(
  root: string,
  localPath: string
): Promise<void> {
  const relative = path.relative(root, localPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  await rm(path.dirname(localPath), { recursive: true, force: true });
}
